import * as vscode from 'vscode';
import { join, extname } from 'path';
import { homedir } from 'os';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { CursorComposerStorageReader } from './storage-reader';

// #region agent log
/**
 * Debug-only logger hook.
 *
 * This repo keeps it as a no-op by default to avoid leaking data or relying on
 * a session-specific ingest server. When doing live reverse-engineering, you
 * can temporarily wire this to a local logging sink.
 */
function debugLog(
  _location: string,
  _message: string,
  _data: Record<string, unknown> = {},
  _hypothesisId: string = 'discovery'
) {
  // no-op
}
// #endregion

export interface ExtensionInfo {
  id: string;
  isActive: boolean;
  exports: unknown;
  exportKeys: string[];
  packageJson: {
    name?: string;
    displayName?: string;
    description?: string;
    contributes?: {
      commands?: Array<{ command: string; title: string }>;
      views?: Record<string, unknown>;
      viewsContainers?: Record<string, unknown>;
    };
  };
}

export interface DebugReport {
  timestamp: string;
  platform: NodeJS.Platform;
  vscodeVersion: string;
  cursorPaths: {
    appData: string;
    logs: string;
    storage: string;
    exists: { appData: boolean; logs: boolean; storage: boolean };
  };
  allExtensions: ExtensionInfo[];
  aiRelatedExtensions: ExtensionInfo[];
  allCommands: string[];
  aiRelatedCommands: string[];
  cursorFiles: string[];
  globalStorageContents: string[];
}

/**
 * Deep inspect an object to get its structure
 */
function inspectObject(obj: unknown, depth = 2, currentDepth = 0): unknown {
  if (currentDepth >= depth) return typeof obj;
  if (obj === null) return null;
  if (obj === undefined) return undefined;
  
  const type = typeof obj;
  if (type !== 'object' && type !== 'function') return obj;
  
  if (type === 'function') {
    return `[Function: ${(obj as Function).name || 'anonymous'}]`;
  }
  
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [];
    return obj.slice(0, 5).map(item => inspectObject(item, depth, currentDepth + 1));
  }
  
  const result: Record<string, unknown> = {};
  const keys = Object.keys(obj as object);
  for (const key of keys.slice(0, 20)) {
    try {
      result[key] = inspectObject((obj as Record<string, unknown>)[key], depth, currentDepth + 1);
    } catch {
      result[key] = '[Error accessing property]';
    }
  }
  if (keys.length > 20) {
    result['...'] = `${keys.length - 20} more keys`;
  }
  return result;
}

/**
 * Get information about an extension
 */
function getExtensionInfo(ext: vscode.Extension<unknown>): ExtensionInfo {
  let exports: unknown = null;
  let exportKeys: string[] = [];
  
  try {
    if (ext.isActive && ext.exports) {
      exports = inspectObject(ext.exports, 3);
      if (typeof ext.exports === 'object' && ext.exports !== null) {
        exportKeys = Object.keys(ext.exports);
      }
    }
  } catch {
    exports = '[Error accessing exports]';
  }
  
  return {
    id: ext.id,
    isActive: ext.isActive,
    exports,
    exportKeys,
    packageJson: {
      name: ext.packageJSON?.name,
      displayName: ext.packageJSON?.displayName,
      description: ext.packageJSON?.description,
      contributes: {
        commands: ext.packageJSON?.contributes?.commands,
        views: ext.packageJSON?.contributes?.views,
        viewsContainers: ext.packageJSON?.contributes?.viewsContainers,
      },
    },
  };
}

/**
 * Get Cursor data paths for the current platform
 */
function getCursorPaths() {
  const platform = process.platform;
  let appData: string;
  
  switch (platform) {
    case 'darwin':
      appData = join(homedir(), 'Library', 'Application Support', 'Cursor');
      break;
    case 'win32':
      appData = join(process.env.APPDATA || '', 'Cursor');
      break;
    default:
      appData = join(homedir(), '.config', 'Cursor');
      break;
  }
  
  const logs = join(appData, 'logs');
  const storage = join(appData, 'User', 'globalStorage');
  
  return {
    appData,
    logs,
    storage,
    exists: {
      appData: existsSync(appData),
      logs: existsSync(logs),
      storage: existsSync(storage),
    },
  };
}

/**
 * List files in a directory recursively (limited depth)
 */
function listFiles(dir: string, depth = 2, currentDepth = 0): string[] {
  if (currentDepth >= depth || !existsSync(dir)) return [];
  
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries.slice(0, 50)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(`${entry}/`);
          if (currentDepth < depth - 1) {
            const subFiles = listFiles(fullPath, depth, currentDepth + 1);
            results.push(...subFiles.map(f => `${entry}/${f}`));
          }
        } else {
          results.push(entry);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return results;
}

/**
 * Check if extension ID is AI/Cursor related
 */
function isAIRelated(id: string): boolean {
  const lc = id.toLowerCase();
  return (
    lc.includes('cursor') ||
    lc.includes('copilot') ||
    lc.includes('ai') ||
    lc.includes('gpt') ||
    lc.includes('claude') ||
    lc.includes('anthropic') ||
    lc.includes('codeium') ||
    lc.includes('tabnine') ||
    lc.includes('intellicode') ||
    lc.includes('chat') ||
    lc.includes('composer') ||
    lc.includes('agent')
  );
}

/**
 * Check if command is AI/Cursor related
 */
function isAICommand(cmd: string): boolean {
  const lc = cmd.toLowerCase();
  return (
    lc.includes('cursor') ||
    lc.includes('copilot') ||
    lc.includes('ai') ||
    lc.includes('chat') ||
    lc.includes('composer') ||
    lc.includes('agent') ||
    lc.includes('inline') ||
    lc.includes('suggest') ||
    lc.includes('complete') ||
    lc.includes('generate')
  );
}

/**
 * Scan for Cursor-specific files in the workspace
 */
function findCursorFiles(): string[] {
  const results: string[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders;
  
  if (!workspaceFolders) return results;
  
  for (const folder of workspaceFolders) {
    const cursorDir = join(folder.uri.fsPath, '.cursor');
    if (existsSync(cursorDir)) {
      results.push(...listFiles(cursorDir, 3).map(f => `.cursor/${f}`));
    }
    
    // Check for other potential cursor files
    const potentialFiles = ['.cursorignore', '.cursorrules', 'cursor.json'];
    for (const file of potentialFiles) {
      if (existsSync(join(folder.uri.fsPath, file))) {
        results.push(file);
      }
    }
  }
  
  return results;
}

/**
 * Generate a full debug report
 */
export async function generateDebugReport(): Promise<DebugReport> {
  // #region agent log
  debugLog('debug.ts:generateDebugReport', 'Starting debug report generation', {}, 'H1');
  // #endregion

  const cursorPaths = getCursorPaths();
  
  // #region agent log
  debugLog('debug.ts:cursorPaths', 'Cursor paths discovered', { cursorPaths }, 'H4');
  // #endregion

  // Get all extensions
  const allExtensions = vscode.extensions.all.map(getExtensionInfo);
  
  // Filter AI-related extensions
  const aiRelatedExtensions = allExtensions.filter(ext => isAIRelated(ext.id));
  
  // #region agent log
  debugLog('debug.ts:extensions', 'Extensions enumerated', {
    total: allExtensions.length,
    aiRelated: aiRelatedExtensions.length,
    aiExtensionIds: aiRelatedExtensions.map(e => e.id),
    activeAIExtensions: aiRelatedExtensions.filter(e => e.isActive).map(e => ({ id: e.id, exportKeys: e.exportKeys }))
  }, 'H1');
  // #endregion

  // Get all commands
  const allCommands = await vscode.commands.getCommands(true);
  const aiRelatedCommands = allCommands.filter(isAICommand);
  
  // #region agent log
  debugLog('debug.ts:commands', 'Commands enumerated', {
    total: allCommands.length,
    aiRelated: aiRelatedCommands.length,
    aiCommands: aiRelatedCommands
  }, 'H3');
  // #endregion

  // Find Cursor files in workspace
  const cursorFiles = findCursorFiles();
  
  // #region agent log
  debugLog('debug.ts:cursorFiles', 'Cursor files in workspace', { cursorFiles }, 'H4');
  // #endregion

  // List global storage contents
  const globalStorageContents = listFiles(cursorPaths.storage, 2);
  
  // #region agent log
  debugLog('debug.ts:globalStorage', 'Global storage contents', {
    storageExists: cursorPaths.exists.storage,
    contents: globalStorageContents.slice(0, 30)
  }, 'H4');
  // #endregion

  const report: DebugReport = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    vscodeVersion: vscode.version,
    cursorPaths,
    allExtensions,
    aiRelatedExtensions,
    allCommands,
    aiRelatedCommands,
    cursorFiles,
    globalStorageContents,
  };
  
  // #region agent log
  debugLog('debug.ts:reportComplete', 'Debug report complete', {
    extensionCount: allExtensions.length,
    aiExtensionCount: aiRelatedExtensions.length,
    commandCount: allCommands.length,
    aiCommandCount: aiRelatedCommands.length
  }, 'discovery');
  // #endregion

  return report;
}

/**
 * Deep inspect a specific extension by ID
 */
export async function inspectExtension(extensionId: string): Promise<ExtensionInfo | null> {
  const ext = vscode.extensions.getExtension(extensionId);
  if (!ext) {
    // #region agent log
    debugLog('debug.ts:inspectExtension', 'Extension not found', { extensionId }, 'H1');
    // #endregion
    return null;
  }
  
  // Try to activate if not active
  if (!ext.isActive) {
    try {
      await ext.activate();
    } catch (err) {
      // #region agent log
      debugLog('debug.ts:inspectExtension', 'Failed to activate extension', { extensionId, error: String(err) }, 'H2');
      // #endregion
    }
  }
  
  const info = getExtensionInfo(ext);
  
  // Do deeper inspection of exports
  if (ext.isActive && ext.exports) {
    // #region agent log
    debugLog('debug.ts:inspectExtension', 'Extension exports inspection', {
      extensionId,
      exportType: typeof ext.exports,
      exportKeys: Object.keys(ext.exports as object),
      exports: inspectObject(ext.exports, 4)
    }, 'H2');
    // #endregion
  }
  
  return info;
}

/**
 * Try various known Cursor extension IDs
 */
export async function probeCursorExtensions(): Promise<Record<string, ExtensionInfo | null>> {
  const knownIds = [
    'cursor.cursor',
    'cursor.aichat',
    'cursor.composer', 
    'cursor.agent',
    'anysphere.cursor',
    'anysphere.aichat',
    'Cursor.cursor',
    'Cursor.aichat',
  ];
  
  const results: Record<string, ExtensionInfo | null> = {};
  
  for (const id of knownIds) {
    results[id] = await inspectExtension(id);
  }
  
  // #region agent log
  debugLog('debug.ts:probeCursorExtensions', 'Probed known Cursor extension IDs', {
    knownIds,
    found: Object.entries(results).filter(([_, v]) => v !== null).map(([k, _]) => k)
  }, 'H1');
  // #endregion
  
  return results;
}

/**
 * Enumerate all extension commands and their contributions
 */
export async function enumerateExtensionCommands(): Promise<Record<string, string[]>> {
  const results: Record<string, string[]> = {};
  
  for (const ext of vscode.extensions.all) {
    const commands = ext.packageJSON?.contributes?.commands;
    if (commands && Array.isArray(commands)) {
      results[ext.id] = commands.map((c: { command: string }) => c.command);
    }
  }
  
  // #region agent log
  debugLog('debug.ts:enumerateExtensionCommands', 'Extension commands enumerated', {
    extensionCount: Object.keys(results).length,
    totalCommands: Object.values(results).flat().length
  }, 'H3');
  // #endregion
  
  return results;
}

/**
 * Probe Cursor's internal commands to discover session data
 */
export async function probeCursorCommands(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  
  // Key commands that might expose session/composer data
  const commandsToProbe = [
    'composer.getBackgroundComposerInfo',
    'composer.getOrderedSelectedComposerIds',
    'composer.getCurrentWorkspaceRepoUrl',
    'debug.logComposer',
    'developer.openAgentTranscript',
  ];
  
  for (const cmd of commandsToProbe) {
    try {
      const result = await vscode.commands.executeCommand(cmd);
      results[cmd] = {
        success: true,
        result: inspectObject(result, 4),
        type: typeof result,
      };
      // #region agent log
      debugLog('debug.ts:probeCursorCommands', `Command ${cmd} returned`, {
        command: cmd,
        resultType: typeof result,
        result: inspectObject(result, 4)
      }, 'H3');
      // #endregion
    } catch (err) {
      results[cmd] = {
        success: false,
        error: String(err),
      };
      // #region agent log
      debugLog('debug.ts:probeCursorCommands', `Command ${cmd} failed`, {
        command: cmd,
        error: String(err)
      }, 'H3');
      // #endregion
    }
  }
  
  // Also try to get MCP lease from the one extension that exports something
  try {
    const mcpExt = vscode.extensions.getExtension('anysphere.cursor-mcp');
    if (mcpExt?.isActive && mcpExt.exports) {
      const exports = mcpExt.exports as { getMcpLease?: () => unknown };
      if (typeof exports.getMcpLease === 'function') {
        const lease = exports.getMcpLease();
        results['anysphere.cursor-mcp.getMcpLease'] = {
          success: true,
          result: inspectObject(lease, 4),
        };
        // #region agent log
        debugLog('debug.ts:probeCursorCommands', 'MCP getMcpLease result', {
          result: inspectObject(lease, 4)
        }, 'H2');
        // #endregion
      }
    }
  } catch (err) {
    results['anysphere.cursor-mcp.getMcpLease'] = {
      success: false,
      error: String(err),
    };
  }
  
  return results;
}

/**
 * Discover all composer-related state by probing various commands
 */
export async function discoverComposerState(): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {};
  
  // Try to get composer IDs
  try {
    const composerIds = await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds');
    state.composerIds = composerIds;
    // #region agent log
    debugLog('debug.ts:discoverComposerState', 'Got composer IDs', { composerIds: inspectObject(composerIds, 3) }, 'H3');
    // #endregion
    
    // If we got IDs, try to get handles for each
    if (Array.isArray(composerIds)) {
      state.composerHandles = {};
      for (const id of composerIds) {
        try {
          const handle = await vscode.commands.executeCommand('composer.getComposerHandleById', id);
          (state.composerHandles as Record<string, unknown>)[String(id)] = inspectObject(handle, 4);
          // #region agent log
          debugLog('debug.ts:discoverComposerState', `Got composer handle for ${id}`, {
            id,
            handle: inspectObject(handle, 4)
          }, 'H3');
          // #endregion
        } catch (err) {
          (state.composerHandles as Record<string, unknown>)[String(id)] = { error: String(err) };
        }
      }
    }
  } catch (err) {
    state.composerIdsError = String(err);
  }
  
  // Try background composer info
  try {
    const bgInfo = await vscode.commands.executeCommand('composer.getBackgroundComposerInfo');
    state.backgroundComposerInfo = inspectObject(bgInfo, 4);
    // #region agent log
    debugLog('debug.ts:discoverComposerState', 'Got background composer info', {
      info: inspectObject(bgInfo, 4)
    }, 'H3');
    // #endregion
  } catch (err) {
    state.backgroundComposerInfoError = String(err);
  }
  
  return state;
}

/**
 * Comprehensive probe of all Cursor extensions and their capabilities
 * This is the main discovery function to find session data APIs
 */
export async function probeAllCursorAPIs(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  
  // 1. Probe all anysphere.* extensions deeply
  const anysphereExtensions = vscode.extensions.all.filter(ext => 
    ext.id.toLowerCase().includes('anysphere') || ext.id.toLowerCase().includes('cursor')
  );
  
  results.extensions = {};
  for (const ext of anysphereExtensions) {
    const extInfo: Record<string, unknown> = {
      id: ext.id,
      isActive: ext.isActive,
      extensionPath: ext.extensionPath,
    };
    
    if (ext.isActive && ext.exports) {
      extInfo.exports = inspectObject(ext.exports, 5);
      extInfo.exportKeys = Object.keys(ext.exports as object);
      
      // Try to call any exported functions
      const exports = ext.exports as Record<string, unknown>;
      extInfo.functionResults = {};
      for (const key of Object.keys(exports)) {
        if (typeof exports[key] === 'function') {
          try {
            const fn = exports[key] as Function;
            const result = fn();
            (extInfo.functionResults as Record<string, unknown>)[key] = inspectObject(result, 5);
          } catch (err) {
            (extInfo.functionResults as Record<string, unknown>)[key] = { error: String(err) };
          }
        }
      }
    }
    
    (results.extensions as Record<string, unknown>)[ext.id] = extInfo;
  }
  
  // #region agent log
  debugLog('debug.ts:probeAllCursorAPIs', 'Probed Cursor extensions', {
    extensionCount: anysphereExtensions.length,
    extensionIds: anysphereExtensions.map(e => e.id),
    activeWithExports: anysphereExtensions.filter(e => e.isActive && e.exports).map(e => e.id)
  }, 'extensions');
  // #endregion
  
  // 2. Try commands that might return model/mode/session info
  const commandsToTry = [
    // Composer/session commands
    'composer.getOrderedSelectedComposerIds',
    'composer.getBackgroundComposerInfo',
    'composer.getComposerHandleById',
    'composer.getCurrentWorkspaceRepoUrl',
    
    // Model/config commands  
    'aiServerConfigService.getCachedServerConfig',
    'aiServerConfigService.forceRefresh',
    'cursorai.action.switchToModel',
    'cursorai.action.switchToComposer1',
    'cursorai.action.switchToDynamicModelSlug',
    
    // Mode commands (might return current mode)
    'composerMode.agent',
    'composerMode.plan', 
    'composerMode.debug',
    'composerMode.chat',
    'composerMode.background',
    
    // Settings/config
    'aiSettings.action.open',
    'chat.openCursorSettings',
    
    // History
    'composer.showComposerHistory',
    'composer.showComposerHistoryEditor',
  ];
  
  results.commands = {};
  for (const cmd of commandsToTry) {
    try {
      // Some commands might open UI, so we catch everything
      const result = await vscode.commands.executeCommand(cmd);
      (results.commands as Record<string, unknown>)[cmd] = {
        success: true,
        resultType: typeof result,
        result: inspectObject(result, 5),
        isNull: result === null,
        isUndefined: result === undefined,
      };
      
      // #region agent log
      debugLog('debug.ts:probeAllCursorAPIs', `Command ${cmd}`, {
        resultType: typeof result,
        result: inspectObject(result, 4)
      }, 'commands');
      // #endregion
    } catch (err) {
      (results.commands as Record<string, unknown>)[cmd] = {
        success: false,
        error: String(err),
      };
    }
  }
  
  // 3. Try to get active composer IDs and probe each one
  try {
    const composerIds = await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds');
    if (Array.isArray(composerIds) && composerIds.length > 0) {
      results.composerDetails = {};
      
      for (const id of composerIds) {
        const details: Record<string, unknown> = { id };
        
        // Try various commands with the composer ID
        const idCommands = [
          'composer.getComposerHandleById',
          'composer.openComposer',
          'composer.copyRequestId',
        ];
        
        for (const cmd of idCommands) {
          try {
            const result = await vscode.commands.executeCommand(cmd, id);
            details[cmd] = inspectObject(result, 5);
          } catch (err) {
            details[cmd] = { error: String(err) };
          }
        }
        
        (results.composerDetails as Record<string, unknown>)[id] = details;
      }
      
      // #region agent log
      debugLog('debug.ts:probeAllCursorAPIs', 'Probed composer details', {
        composerCount: composerIds.length,
        composerIds
      }, 'composers');
      // #endregion
    }
  } catch (err) {
    results.composerDetailsError = String(err);
  }
  
  // 4. Check VS Code configuration for cursor settings
  try {
    const cursorConfig = vscode.workspace.getConfiguration('cursor');
    const allKeys = Object.keys(cursorConfig);
    results.cursorConfig = {};
    for (const key of allKeys) {
      try {
        (results.cursorConfig as Record<string, unknown>)[key] = cursorConfig.get(key);
      } catch {
        // Skip unreadable keys
      }
    }
    
    // Also check other potentially relevant configs
    const otherConfigs = ['ai', 'chat', 'composer', 'aichat'];
    for (const configName of otherConfigs) {
      try {
        const config = vscode.workspace.getConfiguration(configName);
        const keys = Object.keys(config);
        if (keys.length > 0) {
          results[`${configName}Config`] = {};
          for (const key of keys.slice(0, 20)) {
            try {
              (results[`${configName}Config`] as Record<string, unknown>)[key] = config.get(key);
            } catch {
              // Skip
            }
          }
        }
      } catch {
        // Config doesn't exist
      }
    }
  } catch (err) {
    results.configError = String(err);
  }
  
  // #region agent log
  debugLog('debug.ts:probeAllCursorAPIs', 'Probe complete', {
    extensionsProbed: Object.keys(results.extensions as object).length,
    commandsProbed: Object.keys(results.commands as object).length,
    hasComposerDetails: !!results.composerDetails
  }, 'complete');
  // #endregion
  
  return results;
}

/**
 * Explore storage files for session data
 * Uses VS Code API to get proper storage locations
 */
export async function exploreStorageFiles(context: vscode.ExtensionContext): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  
  // Get storage paths from VS Code API
  const storagePaths = {
    globalStorageUri: context.globalStorageUri?.fsPath,
    storageUri: context.storageUri?.fsPath,
    logUri: context.logUri?.fsPath,
    extensionPath: context.extensionPath,
  };
  
  results.storagePaths = storagePaths;
  
  // #region agent log
  debugLog('debug.ts:exploreStorageFiles', 'Storage paths from VS Code API', storagePaths, 'storage');
  // #endregion
  
  // Also get the Cursor app data paths
  const osPlatform = process.platform;
  let cursorAppData: string;
  switch (osPlatform) {
    case 'darwin':
      cursorAppData = join(homedir(), 'Library', 'Application Support', 'Cursor');
      break;
    case 'win32':
      cursorAppData = join(process.env.APPDATA || '', 'Cursor');
      break;
    default:
      cursorAppData = join(homedir(), '.config', 'Cursor');
      break;
  }
  
  const cursorPaths = {
    appData: cursorAppData,
    userStorage: join(cursorAppData, 'User'),
    workspaceStorage: join(cursorAppData, 'User', 'workspaceStorage'),
    globalStorage: join(cursorAppData, 'User', 'globalStorage'),
    logs: join(cursorAppData, 'logs'),
  };
  
  results.cursorPaths = cursorPaths;
  
  // File extensions to look for
  const dataExtensions = ['.json', '.sqlite', '.db', '.ndjson', '.jsonl', '.sqlite3', '.vscdb'];
  
  // Function to scan a directory for data files
  function scanDirectory(dir: string, depth = 3, currentDepth = 0): Array<{path: string, size: number, ext: string}> {
    const files: Array<{path: string, size: number, ext: string}> = [];
    if (currentDepth >= depth || !existsSync(dir)) return files;
    
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            files.push(...scanDirectory(fullPath, depth, currentDepth + 1));
          } else {
            const ext = extname(entry).toLowerCase();
            if (dataExtensions.includes(ext) || entry.includes('state') || entry.includes('storage')) {
              files.push({ path: fullPath, size: stat.size, ext });
            }
          }
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Skip inaccessible directories
    }
    return files;
  }
  
  // Function to try reading and parsing a file
  function tryReadFile(filePath: string, maxSize = 1024 * 1024): unknown {
    try {
      const stat = statSync(filePath);
      if (stat.size > maxSize) {
        return { tooLarge: true, size: stat.size };
      }
      
      const ext = extname(filePath).toLowerCase();
      const content = readFileSync(filePath);
      
      if (ext === '.json') {
        return JSON.parse(content.toString('utf-8'));
      } else if (ext === '.ndjson' || ext === '.jsonl') {
        const lines = content.toString('utf-8').split('\n').filter(l => l.trim());
        return lines.slice(0, 10).map(l => {
          try { return JSON.parse(l); } catch { return l; }
        });
      } else if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3' || ext === '.vscdb') {
        // Can't parse SQLite directly, but note its existence
        return { 
          type: 'sqlite',
          size: stat.size,
          note: 'SQLite database - would need sqlite3 module to read'
        };
      } else {
        // Try to read as text/JSON
        const text = content.toString('utf-8');
        try {
          return JSON.parse(text);
        } catch {
          // Return first 500 chars of text
          return { text: text.slice(0, 500), truncated: text.length > 500 };
        }
      }
    } catch (err) {
      return { error: String(err) };
    }
  }
  
  // Scan workspace storage
  results.workspaceStorageFiles = [];
  if (existsSync(cursorPaths.workspaceStorage)) {
    const wsFiles = scanDirectory(cursorPaths.workspaceStorage, 4);
    results.workspaceStorageFiles = wsFiles.map(f => ({
      ...f,
      relativePath: f.path.replace(cursorPaths.workspaceStorage, '')
    }));
    
    // #region agent log
    debugLog('debug.ts:exploreStorageFiles', 'Workspace storage files found', {
      count: wsFiles.length,
      files: wsFiles.slice(0, 20).map(f => ({ path: f.path.replace(cursorPaths.workspaceStorage, ''), size: f.size, ext: f.ext }))
    }, 'storage');
    // #endregion
  }
  
  // Scan global storage
  results.globalStorageFiles = [];
  if (existsSync(cursorPaths.globalStorage)) {
    const gsFiles = scanDirectory(cursorPaths.globalStorage, 3);
    results.globalStorageFiles = gsFiles.map(f => ({
      ...f,
      relativePath: f.path.replace(cursorPaths.globalStorage, '')
    }));
    
    // #region agent log
    debugLog('debug.ts:exploreStorageFiles', 'Global storage files found', {
      count: gsFiles.length,
      files: gsFiles.slice(0, 20).map(f => ({ path: f.path.replace(cursorPaths.globalStorage, ''), size: f.size, ext: f.ext }))
    }, 'storage');
    // #endregion
  }
  
  // Look for files that might contain session/composer data
  const interestingPatterns = ['composer', 'chat', 'session', 'history', 'conversation', 'agent', 'state'];
  const allFiles = [...(results.workspaceStorageFiles as any[]), ...(results.globalStorageFiles as any[])];
  
  results.interestingFiles = {};
  for (const file of allFiles) {
    const pathLower = file.path.toLowerCase();
    const matchedPattern = interestingPatterns.find(p => pathLower.includes(p));
    
    if (matchedPattern || file.ext === '.json' || file.ext === '.ndjson') {
      const content = tryReadFile(file.path, 512 * 1024); // 512KB max
      (results.interestingFiles as Record<string, unknown>)[file.relativePath || file.path] = {
        size: file.size,
        ext: file.ext,
        matchedPattern,
        content: inspectObject(content, 5)
      };
      
      // #region agent log
      debugLog('debug.ts:exploreStorageFiles', `Read file: ${file.relativePath || file.path}`, {
        size: file.size,
        ext: file.ext,
        matchedPattern,
        contentType: typeof content,
        contentKeys: content && typeof content === 'object' ? Object.keys(content).slice(0, 10) : null
      }, 'storage-file');
      // #endregion
    }
  }
  
  // Also scan for state.vscdb files specifically (VS Code's SQLite-based storage)
  results.vscdbFiles = allFiles.filter(f => f.ext === '.vscdb').map(f => ({
    path: f.relativePath || f.path,
    size: f.size
  }));
  
  // #region agent log
  debugLog('debug.ts:exploreStorageFiles', 'Storage exploration complete', {
    workspaceFileCount: (results.workspaceStorageFiles as any[]).length,
    globalFileCount: (results.globalStorageFiles as any[]).length,
    interestingFileCount: Object.keys(results.interestingFiles as object).length,
    vscdbFileCount: (results.vscdbFiles as any[]).length
  }, 'storage-complete');
  // #endregion
  
  return results;
}

/**
 * Register debug commands for the extension
 */
export function registerDebugCommands(context: vscode.ExtensionContext): void {
  // #region agent log
  debugLog(
    'debug.ts:registerDebugCommands',
    'Registering debug commands',
    {
      extensionId: vscode.extensions.getExtension('deadhand.deadhand')?.id,
      extensionVersion: vscode.extensions.getExtension('deadhand.deadhand')?.packageJSON?.version,
    },
    'H_cmd_palette'
  );
  // #endregion
  // Command to generate and show debug report
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.generateReport', async () => {
      const report = await generateDebugReport();
      
      // Create a new document with the report
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(report, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
      
      vscode.window.showInformationMessage('Debug report generated. Check the logs for detailed instrumentation.');
    })
  );
  
  // Command to probe Cursor extensions
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.probeCursor', async () => {
      const results = await probeCursorExtensions();
      
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(results, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );
  
  // Command to list all AI commands
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.listAICommands', async () => {
      const allCommands = await vscode.commands.getCommands(true);
      const aiCommands = allCommands.filter(isAICommand);
      
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(aiCommands, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );
  
  // Command to inspect specific extension
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.inspectExtension', async () => {
      const extensionId = await vscode.window.showInputBox({
        prompt: 'Enter extension ID to inspect',
        placeHolder: 'e.g., cursor.cursor',
      });
      
      if (!extensionId) return;
      
      const info = await inspectExtension(extensionId);
      
      const doc = await vscode.workspace.openTextDocument({
        content: info ? JSON.stringify(info, null, 2) : 'Extension not found',
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );
  
  // Command to list all extensions with exports
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.listExports', async () => {
      const extensions = vscode.extensions.all
        .filter(ext => ext.isActive && ext.exports)
        .map(ext => ({
          id: ext.id,
          exportKeys: ext.exports ? Object.keys(ext.exports as object) : [],
          exports: inspectObject(ext.exports, 3),
        }));
      
      // #region agent log
      debugLog('debug.ts:listExports', 'All extensions with exports', {
        count: extensions.length,
        extensions: extensions.map(e => ({ id: e.id, keys: e.exportKeys }))
      }, 'H2');
      // #endregion
      
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(extensions, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );
  
  // Command to probe Cursor's internal commands
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.probeCursorCommands', async () => {
      vscode.window.showInformationMessage('Probing Cursor commands... Check debug logs.');
      const results = await probeCursorCommands();
      
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(results, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );
  
  // Command to discover composer state
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.discoverComposerState', async () => {
      vscode.window.showInformationMessage('Discovering composer state... Check debug logs.');
      const state = await discoverComposerState();
      
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(state, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );
  
  // Command to run comprehensive Cursor API probe
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.probeAllCursorAPIs', async () => {
      vscode.window.showInformationMessage('Running comprehensive Cursor API probe... This may take a moment.');
      const results = await probeAllCursorAPIs();
      
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(results, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
      
      vscode.window.showInformationMessage('Probe complete! Check debug logs for detailed results.');
    })
  );
  
  // Command to explore storage files for session data
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.exploreStorage', async () => {
      vscode.window.showInformationMessage('Exploring storage files... This may take a moment.');
      const results = await exploreStorageFiles(context);
      
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(results, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
      
      vscode.window.showInformationMessage('Storage exploration complete! Check debug logs for details.');
    })
  );

  // Command to diagnose transcript storage for a specific composer/session
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.diagnoseTranscript', async () => {
      // #region agent log
      debugLog(
        'debug.ts:diagnoseTranscript',
        'Command invoked',
        { hasActiveEditor: !!vscode.window.activeTextEditor },
        'H_transcripts_missing'
      );
      // #endregion
      // First, get list of active composer IDs
      let composerIds: string[] = [];
      try {
        composerIds = await vscode.commands.executeCommand<string[]>(
          'composer.getOrderedSelectedComposerIds'
        ) || [];
      } catch {
        // Command might not exist
      }
      // #region agent log
      debugLog(
        'debug.ts:diagnoseTranscript',
        'Loaded composer IDs',
        { composerIdCount: composerIds.length },
        'H_transcripts_missing'
      );
      // #endregion

      // Ask user to select or enter a composer ID
      let composerId: string | undefined;
      if (composerIds.length > 0) {
        const items = [
          ...composerIds.map(id => ({ label: id, description: 'Active composer' })),
          { label: 'Enter custom ID...', description: '' }
        ];
        const selected = await vscode.window.showQuickPick(items, {
          title: 'Select Composer ID to Diagnose',
          placeHolder: 'Choose an active composer or enter a custom ID',
        });
        
        if (!selected) return;
        
        if (selected.label === 'Enter custom ID...') {
          composerId = await vscode.window.showInputBox({
            prompt: 'Enter composer/session ID to diagnose',
            placeHolder: 'e.g., 6e768b5f-4e1f-4876-b527-500cceb84428',
          });
        } else {
          composerId = selected.label;
        }
      } else {
        composerId = await vscode.window.showInputBox({
          prompt: 'Enter composer/session ID to diagnose',
          placeHolder: 'e.g., 6e768b5f-4e1f-4876-b527-500cceb84428',
        });
      }

      if (!composerId) return;

      vscode.window.showInformationMessage(`Diagnosing transcript storage for: ${composerId}`);
      // #region agent log
      debugLog(
        'debug.ts:diagnoseTranscript',
        'Selected composer',
        { composerIdPrefix: composerId.slice(0, 8) },
        'H_transcripts_missing'
      );
      // #endregion

      const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
      
      try {
        // Run diagnosis
        const diagnosis = await storageReader.diagnoseTranscriptStorage(composerId);
        
        // Also try to get the actual transcript
        const transcript = await storageReader.getConversationTranscript(composerId);
        // #region agent log
        debugLog(
          'debug.ts:diagnoseTranscript',
          'Transcript fetched',
          {
            dbOpen: diagnosis.dbOpen,
            keysChecked: diagnosis.keysChecked.length,
            discoveredKeyCount: diagnosis.discoveredKeys.length,
            messageCount: transcript.messages.length,
          },
          'H_transcripts_missing'
        );
        // #endregion

        // List all keys in the database for reference
        const allKeys = await storageReader.listAllKeys();
        const conversationRelatedKeys = allKeys.filter(k => 
          k.includes('conversation') || 
          k.includes('messages') || 
          k.includes('bubbles') ||
          k.includes('chat') ||
          k.includes('composer')
        );

        const report = {
          composerId,
          timestamp: new Date().toISOString(),
          diagnosis,
          transcriptResult: {
            messageCount: transcript.messages.length,
            // Don't include actual content, just metadata
            messageSummary: transcript.messages.slice(0, 10).map(m => ({
              role: m.role,
              contentLength: m.content.length,
              hasToolCall: !!m.toolCall,
              timestamp: m.timestamp,
            })),
          },
          conversationRelatedKeys,
          totalKeysInDb: allKeys.length,
        };

        // #region agent log
        debugLog('debug.ts:diagnoseTranscript', 'Transcript diagnosis complete', {
          composerId,
          dbPath: diagnosis.dbPath,
          dbOpen: diagnosis.dbOpen,
          keysChecked: diagnosis.keysChecked.length,
          discoveredKeys: diagnosis.discoveredKeys,
          cachedKey: diagnosis.cachedKey,
          messageCount: transcript.messages.length,
        }, 'transcript-diagnosis');
        // #endregion

        const doc = await vscode.workspace.openTextDocument({
          content: JSON.stringify(report, null, 2),
          language: 'json',
        });
        await vscode.window.showTextDocument(doc);

        if (transcript.messages.length > 0) {
          vscode.window.showInformationMessage(
            `Found ${transcript.messages.length} messages for composer ${composerId.slice(0, 8)}...`
          );
        } else {
          vscode.window.showWarningMessage(
            `No transcript messages found for composer ${composerId.slice(0, 8)}... Check the diagnosis report.`
          );
        }
      } finally {
        await storageReader.dispose();
      }
    })
  );

  // Command to execute an arbitrary VS Code command with JSON args
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.execCommand', async () => {
      // Get the command ID
      const commandId = await vscode.window.showInputBox({
        prompt: 'Enter command ID to execute',
        placeHolder: 'e.g., composer.openComposer',
      });

      if (!commandId) return;

      // Get optional JSON args
      const argsInput = await vscode.window.showInputBox({
        prompt: 'Enter JSON args (optional, leave empty for no args)',
        placeHolder: 'e.g., ["arg1", {"key": "value"}] or just "composerId"',
        value: '',
      });

      let args: unknown[] = [];
      if (argsInput && argsInput.trim()) {
        try {
          const parsed = JSON.parse(argsInput);
          // If it's an array, use as-is; otherwise wrap in array
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch (err) {
          // If not valid JSON, treat as a single string argument
          args = [argsInput];
        }
      }

      const result: Record<string, unknown> = {
        commandId,
        args,
        timestamp: new Date().toISOString(),
      };

      try {
        vscode.window.showInformationMessage(`Executing: ${commandId} with ${args.length} args...`);
        const commandResult = await vscode.commands.executeCommand(commandId, ...args);
        result.success = true;
        result.resultType = typeof commandResult;
        result.result = inspectObject(commandResult, 5);
        result.isNull = commandResult === null;
        result.isUndefined = commandResult === undefined;
      } catch (err) {
        result.success = false;
        result.error = String(err);
        result.errorStack = (err as Error).stack;
      }

      // #region agent log
      debugLog('debug.ts:execCommand', `Executed command: ${commandId}`, {
        commandId,
        argsCount: args.length,
        success: result.success,
        resultType: result.resultType,
      }, 'exec-command');
      // #endregion

      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(result, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);

      if (result.success) {
        vscode.window.showInformationMessage(`Command executed successfully. Result type: ${result.resultType}`);
      } else {
        vscode.window.showErrorMessage(`Command failed: ${result.error}`);
      }
    })
  );

  // Command to list all composer-related commands
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.listComposerCommands', async () => {
      const allCommands = await vscode.commands.getCommands(true);
      
      const composerCommands = allCommands.filter(cmd => {
        const lc = cmd.toLowerCase();
        return (
          lc.includes('composer') ||
          lc.includes('aichat') ||
          lc.includes('workbench.action.chat') ||
          lc.includes('cursorai') ||
          lc.includes('composermode')
        );
      }).sort();

      const categorized = {
        submit: composerCommands.filter(c => c.includes('submit') || c.includes('send')),
        open: composerCommands.filter(c => c.includes('open') || c.includes('focus') || c.includes('start')),
        mode: composerCommands.filter(c => c.includes('mode') || c.includes('Mode')),
        other: composerCommands.filter(c => 
          !c.includes('submit') && !c.includes('send') &&
          !c.includes('open') && !c.includes('focus') && !c.includes('start') &&
          !c.includes('mode') && !c.includes('Mode')
        ),
        total: composerCommands.length,
      };

      // #region agent log
      debugLog('debug.ts:listComposerCommands', 'Composer commands enumerated', {
        total: composerCommands.length,
        submitCount: categorized.submit.length,
        openCount: categorized.open.length,
        modeCount: categorized.mode.length,
      }, 'composer-commands');
      // #endregion

      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(categorized, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );

  // Command to list models that are currently enabled in this Cursor instance (matches Settings > Models toggles)
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.listEnabledModels', async () => {
      const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
      let enabled: Array<{ name: string; clientDisplayName?: string; serverModelName?: string }> = [];
      try {
        enabled = await storageReader.getEnabledModels();
      } finally {
        await storageReader.dispose();
      }

      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify({ count: enabled.length, enabled }, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );

  // Command to attempt sending a message to a composer session
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.sendMessageToComposer', async () => {
      // Get list of active composer IDs
      let composerIds: string[] = [];
      try {
        composerIds = await vscode.commands.executeCommand<string[]>(
          'composer.getOrderedSelectedComposerIds'
        ) || [];
      } catch {
        // Command might not exist
      }

      // Ask user to select or enter a composer ID
      let composerId: string | undefined;
      if (composerIds.length > 0) {
        const items = [
          ...composerIds.map(id => ({ label: id, description: 'Active composer' })),
          { label: 'Enter custom ID...', description: '' }
        ];
        const selected = await vscode.window.showQuickPick(items, {
          title: 'Select Composer to Send Message To',
          placeHolder: 'Choose an active composer or enter a custom ID',
        });
        
        if (!selected) return;
        
        if (selected.label === 'Enter custom ID...') {
          composerId = await vscode.window.showInputBox({
            prompt: 'Enter composer/session ID',
            placeHolder: 'e.g., 6e768b5f-4e1f-4876-b527-500cceb84428',
          });
        } else {
          composerId = selected.label;
        }
      } else {
        composerId = await vscode.window.showInputBox({
          prompt: 'Enter composer/session ID',
          placeHolder: 'e.g., 6e768b5f-4e1f-4876-b527-500cceb84428',
        });
      }

      if (!composerId) return;

      // Get the message to send
      const message = await vscode.window.showInputBox({
        prompt: 'Enter message to send',
        placeHolder: 'e.g., Hello from Deadhand!',
        validateInput: (value) => value.trim() ? null : 'Message cannot be empty',
      });

      if (!message) return;

      const result: Record<string, unknown> = {
        composerId,
        messageLength: message.length,
        messageHash: Buffer.from(message).toString('base64').slice(0, 16) + '...',
        timestamp: new Date().toISOString(),
        attempts: [] as Array<{ method: string; success: boolean; error?: string; result?: unknown }>,
      };

      // #region agent log
      debugLog('debug.ts:sendMessageToComposer', 'Attempting to send message', {
        composerId: composerId.slice(0, 8) + '...',
        messageLength: message.length,
      }, 'send-message');
      // #endregion

      // Strategy 1: Try composer.openComposer + composer.submit
      try {
        // First, open/focus the composer
        await vscode.commands.executeCommand('composer.openComposer', composerId);
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait for UI to update

        // Try to focus the input
        try {
          await vscode.commands.executeCommand('workbench.action.chat.focusInput');
        } catch {
          // May not exist, continue anyway
        }

        // Try composer.submit (this may need the text to be in the input already)
        // Unfortunately, we can't directly set the input text via command
        // So we'll try a different approach
        (result.attempts as any[]).push({
          method: 'composer.openComposer',
          success: true,
          note: 'Opened composer, but cannot inject text directly',
        });
      } catch (err) {
        (result.attempts as any[]).push({
          method: 'composer.openComposer',
          success: false,
          error: String(err),
        });
      }

      // Strategy 2: Try composer.startComposerPrompt (may start a new composer with the prompt)
      try {
        const promptResult = await vscode.commands.executeCommand(
          'composer.startComposerPrompt',
          message
        );
        (result.attempts as any[]).push({
          method: 'composer.startComposerPrompt',
          success: true,
          result: inspectObject(promptResult, 3),
          note: 'This may have started a NEW composer with the prompt',
        });
      } catch (err) {
        (result.attempts as any[]).push({
          method: 'composer.startComposerPrompt',
          success: false,
          error: String(err),
        });
      }

      // Strategy 3: Try aichat.newchataction with message
      try {
        const chatResult = await vscode.commands.executeCommand(
          'aichat.newchataction',
          { message }
        );
        (result.attempts as any[]).push({
          method: 'aichat.newchataction',
          success: true,
          result: inspectObject(chatResult, 3),
        });
      } catch (err) {
        (result.attempts as any[]).push({
          method: 'aichat.newchataction',
          success: false,
          error: String(err),
        });
      }

      // Strategy 4: Try workbench.action.chat.open with query
      try {
        const wcResult = await vscode.commands.executeCommand(
          'workbench.action.chat.open',
          { query: message }
        );
        (result.attempts as any[]).push({
          method: 'workbench.action.chat.open',
          success: true,
          result: inspectObject(wcResult, 3),
        });
      } catch (err) {
        (result.attempts as any[]).push({
          method: 'workbench.action.chat.open',
          success: false,
          error: String(err),
        });
      }

      // Verify by checking transcript
      const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
      try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for storage update
        const transcript = await storageReader.getConversationTranscript(composerId);
        result.verificationMessageCount = transcript.messages.length;
        result.lastMessage = transcript.messages.length > 0 ? {
          role: transcript.messages[transcript.messages.length - 1].role,
          contentLength: transcript.messages[transcript.messages.length - 1].content.length,
          timestamp: transcript.messages[transcript.messages.length - 1].timestamp,
        } : null;
      } catch (err) {
        result.verificationError = String(err);
      } finally {
        await storageReader.dispose();
      }

      // #region agent log
      debugLog('debug.ts:sendMessageToComposer', 'Send message attempts complete', {
        composerId: composerId.slice(0, 8) + '...',
        attemptCount: (result.attempts as any[]).length,
        successCount: (result.attempts as any[]).filter((a: any) => a.success).length,
        verificationMessageCount: result.verificationMessageCount,
      }, 'send-message-complete');
      // #endregion

      result.summary = {
        anySuccess: (result.attempts as any[]).some((a: any) => a.success),
        successfulMethods: (result.attempts as any[]).filter((a: any) => a.success).map((a: any) => a.method),
        recommendation: 'Check the attempts array and verification to see which method worked.',
      };

      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(result, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);

      const successCount = (result.attempts as any[]).filter((a: any) => a.success).length;
      if (successCount > 0) {
        vscode.window.showInformationMessage(
          `${successCount} method(s) succeeded. Check the report for details.`
        );
      } else {
        vscode.window.showWarningMessage(
          'All methods failed. Check the report for errors.'
        );
      }
    })
  );

  // Command to create a new chat via Cursor's deeplink prompt prefill and then submit it.
  // This avoids OS-level automation and avoids VS Code's unified chat commands (which are not registered in some Cursor builds).
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.deeplinkPromptSubmit', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Prompt to create + submit in a NEW composer',
        placeHolder: 'e.g., Hello from Deadhand',
        validateInput: (v) => (v.trim().length > 0 ? null : 'Prompt cannot be empty'),
      });
      if (!message) return;

      const msgHash = await crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(message))
        .then((b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join(''))
        .then((h) => h.slice(0, 12));

      const allCommands = await vscode.commands.getCommands(true);
      const hasDeeplinkPrefill = allCommands.includes('deeplink.prompt.prefill');
      const hasTriggerSubmit = allCommands.includes('composer.triggerCreateWorktreeButton');
      const hasGetOrdered = allCommands.includes('composer.getOrderedSelectedComposerIds');

      if (!hasDeeplinkPrefill) {
        vscode.window.showErrorMessage("Cursor command 'deeplink.prompt.prefill' not found in this build.");
        return;
      }

      let beforeSelected: string[] = [];
      if (hasGetOrdered) {
        try {
          beforeSelected =
            (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];
        } catch {
          beforeSelected = [];
        }
      }

      // Run Cursor's prompt deeplink handler (shows a confirmation dialog)
      try {
        await vscode.commands.executeCommand('deeplink.prompt.prefill', { text: message });
      } catch (err) {
        vscode.window.showErrorMessage(`deeplink.prompt.prefill failed: ${String(err)}`);
        return;
      }

      let afterSelected: string[] = [];
      if (hasGetOrdered) {
        try {
          afterSelected =
            (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];
        } catch {
          afterSelected = [];
        }
      }

      const newlySelected = afterSelected.find((id) => !beforeSelected.includes(id));
      const targetComposerId = newlySelected ?? afterSelected[0] ?? null;

      const report: any = {
        messageLength: message.length,
        messageHashPrefix: msgHash,
        commands: {
          hasDeeplinkPrefill,
          hasTriggerSubmit,
          hasGetOrdered,
        },
        beforeSelected,
        afterSelected,
        targetComposerId,
        submitAttempt: null,
        verification: null,
      };

      if (!targetComposerId) {
        report.submitAttempt = { ok: false, error: 'Could not determine newly created composerId' };
      } else if (!hasTriggerSubmit) {
        report.submitAttempt = { ok: false, error: "Command 'composer.triggerCreateWorktreeButton' not found" };
      } else {
        try {
          await vscode.commands.executeCommand('composer.triggerCreateWorktreeButton');
          report.submitAttempt = { ok: true };
        } catch (err) {
          report.submitAttempt = { ok: false, error: String(err) };
        }
      }

      // Verify by checking transcript for a new user bubble
      if (targetComposerId) {
        const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
        try {
          const start = Date.now();
          let transcript = await storageReader.getConversationTranscript(targetComposerId);
          let delivered = transcript.messages.some(
            (m) => m.role === 'user' && (m.content ?? '').trim() === message.trim()
          );
          while (!delivered && Date.now() - start < 5000) {
            await new Promise((r) => setTimeout(r, 250));
            transcript = await storageReader.getConversationTranscript(targetComposerId);
            delivered = transcript.messages.some(
              (m) => m.role === 'user' && (m.content ?? '').trim() === message.trim()
            );
          }
          report.verification = {
            delivered,
            messageCount: transcript.messages.length,
            lastRole: transcript.messages.at(-1)?.role ?? null,
          };
        } catch (err) {
          report.verification = { delivered: false, error: String(err) };
        } finally {
          await storageReader.dispose();
        }
      }

      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(report, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );

  // Create + submit a NEW composer without deeplink confirmation dialogs by calling Cursor's internal command
  // `composer.createNew` with partialState text, then submitting via `composer.triggerCreateWorktreeButton`.
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.debug.createComposerSubmit', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Prompt to create + submit in a NEW composer (no deeplink confirmation)',
        placeHolder: 'e.g., Hello from Deadhand',
        validateInput: (v) => (v.trim().length > 0 ? null : 'Prompt cannot be empty'),
      });
      if (!message) return;

      const msgHash = await crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(message))
        .then((b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join(''))
        .then((h) => h.slice(0, 12));

      const allCommands = await vscode.commands.getCommands(true);
      const hasCreateNew = allCommands.includes('composer.createNew');
      const hasTriggerSubmit = allCommands.includes('composer.triggerCreateWorktreeButton');
      const hasGetOrdered = allCommands.includes('composer.getOrderedSelectedComposerIds');
      const hasOpenComposer = allCommands.includes('composer.openComposer');

      // Model selection (use Cursor's enabled model list from applicationUser.availableDefaultModels2)
      const storageReaderForModels = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
      let modelOverride: { modelName: string; maxMode: boolean } | null = null;
      try {
        const enabled = await storageReaderForModels.getEnabledModels();
        const enabledNames = enabled.map((m) => m.name);

        const items: Array<vscode.QuickPickItem & { dhKind: 'default' | 'model' | 'custom' }> = [
          { label: 'Use default model (no override)', description: '', dhKind: 'default' },
          ...enabledNames
            .sort()
            .map((m) => ({ label: m, description: 'Enabled in this Cursor instance', dhKind: 'model' as const })),
          { label: 'Enter custom model name…', description: '', dhKind: 'custom' },
        ];

        const picked = await vscode.window.showQuickPick(items, {
          title: 'Model settings for new composer',
          placeHolder: 'Choose model (optional)',
        });
        if (!picked) return;

        if (picked.dhKind === 'custom') {
          const custom = await vscode.window.showInputBox({
            prompt: 'Enter model name (Cursor internal)',
            placeHolder: 'e.g., default, gpt-5.1-codex, claude-4.5-opus-high-thinking',
            validateInput: (v) => (v.trim().length > 0 ? null : 'Model name cannot be empty'),
          });
          if (!custom) return;
          const maxModePick = await vscode.window.showQuickPick(
            [
              { label: 'maxMode: false', description: 'Default' },
              { label: 'maxMode: true', description: 'More thorough (if supported by model)' },
            ],
            { title: 'Max mode', placeHolder: 'Choose maxMode setting' }
          );
          if (!maxModePick) return;
          modelOverride = { modelName: custom.trim(), maxMode: maxModePick.label.includes('true') };
        } else if (picked.dhKind === 'model' && picked.label !== 'default') {
          const maxModePick = await vscode.window.showQuickPick(
            [
              { label: 'maxMode: false', description: 'Default' },
              { label: 'maxMode: true', description: 'More thorough (if supported by model)' },
            ],
            { title: 'Max mode', placeHolder: 'Choose maxMode setting' }
          );
          if (!maxModePick) return;
          modelOverride = { modelName: picked.label, maxMode: maxModePick.label.includes('true') };
        } else if (picked.dhKind === 'model' && picked.label === 'default') {
          // treat "default" as an explicit override (useful if user wants maxMode)
          const maxModePick = await vscode.window.showQuickPick(
            [
              { label: 'maxMode: false', description: 'Default' },
              { label: 'maxMode: true', description: 'More thorough (if supported by model)' },
            ],
            { title: 'Max mode', placeHolder: 'Choose maxMode setting' }
          );
          if (!maxModePick) return;
          modelOverride = { modelName: 'default', maxMode: maxModePick.label.includes('true') };
        } else {
          modelOverride = null; // no override
        }
      } finally {
        await storageReaderForModels.dispose();
      }

      // Mode selection (unifiedMode)
      // Cursor UI label "Ask" corresponds to internal unifiedMode "chat".
      const modePick = await vscode.window.showQuickPick(
        [
          { label: 'Agent', description: 'Internal: agent', dhMode: 'agent' as const },
          { label: 'Ask', description: 'Internal: chat', dhMode: 'chat' as const },
          { label: 'Debug', description: 'Internal: debug', dhMode: 'debug' as const },
          { label: 'Plan', description: 'Internal: plan', dhMode: 'plan' as const },
          { label: 'Edit', description: 'Internal: edit', dhMode: 'edit' as const },
          { label: 'Background', description: 'Internal: background', dhMode: 'background' as const },
        ],
        { title: 'Composer mode', placeHolder: 'Choose unifiedMode', canPickMany: false }
      );
      if (!modePick) return;
      const unifiedMode = (modePick as any).dhMode as string;

      if (!hasCreateNew) {
        vscode.window.showErrorMessage("Cursor command 'composer.createNew' not found in this build.");
        return;
      }

      let beforeSelected: string[] = [];
      if (hasGetOrdered) {
        try {
          beforeSelected =
            (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];
        } catch {
          beforeSelected = [];
        }
      }

      let createResult: unknown = null;
      try {
        createResult = await vscode.commands.executeCommand('composer.createNew', {
          openInNewTab: true,
          partialState: {
            unifiedMode,
            text: message,
            richText: message,
            ...(modelOverride ? { modelConfig: { modelName: modelOverride.modelName, maxMode: modelOverride.maxMode } } : {}),
          },
        });
      } catch (err) {
        vscode.window.showErrorMessage(`composer.createNew failed: ${String(err)}`);
        return;
      }

      let afterSelected: string[] = [];
      if (hasGetOrdered) {
        try {
          afterSelected =
            (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];
        } catch {
          afterSelected = [];
        }
      }

      const createdComposerIdFromResult =
        createResult && typeof createResult === 'object' && 'composerId' in (createResult as any)
          ? String((createResult as any).composerId)
          : null;

      const newlySelected = afterSelected.find((id) => !beforeSelected.includes(id));
      const targetComposerId = createdComposerIdFromResult ?? newlySelected ?? afterSelected[0] ?? null;

      // Best-effort: focus the new composer so submit command uses the correct selected id.
      if (targetComposerId && hasOpenComposer) {
        try {
          await vscode.commands.executeCommand('composer.openComposer', targetComposerId, {
            focusMainInputBox: true,
            insertSelection: false,
          });
        } catch {
          // ignore
        }
      }

      const report: any = {
        messageLength: message.length,
        messageHashPrefix: msgHash,
        modelOverride,
        unifiedMode,
        commands: {
          hasCreateNew,
          hasTriggerSubmit,
          hasGetOrdered,
          hasOpenComposer,
        },
        beforeSelected,
        afterSelected,
        createResult: inspectObject(createResult, 3),
        targetComposerId,
        submitAttempt: null,
        verification: null,
      };

      if (!targetComposerId) {
        report.submitAttempt = { ok: false, error: 'Could not determine newly created composerId' };
      } else if (!hasTriggerSubmit) {
        report.submitAttempt = { ok: false, error: "Command 'composer.triggerCreateWorktreeButton' not found" };
      } else {
        try {
          await vscode.commands.executeCommand('composer.triggerCreateWorktreeButton');
          report.submitAttempt = { ok: true };
        } catch (err) {
          report.submitAttempt = { ok: false, error: String(err) };
        }
      }

      // Verify by checking transcript for a new user bubble
      if (targetComposerId) {
        const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
        try {
          const start = Date.now();
          let transcript = await storageReader.getConversationTranscript(targetComposerId);
          let delivered = transcript.messages.some(
            (m) => m.role === 'user' && (m.content ?? '').trim() === message.trim()
          );
          while (!delivered && Date.now() - start < 5000) {
            await new Promise((r) => setTimeout(r, 250));
            transcript = await storageReader.getConversationTranscript(targetComposerId);
            delivered = transcript.messages.some(
              (m) => m.role === 'user' && (m.content ?? '').trim() === message.trim()
            );
          }
          report.verification = {
            delivered,
            messageCount: transcript.messages.length,
            lastRole: transcript.messages.at(-1)?.role ?? null,
            modelConfig: await storageReader.getComposerModelConfig(targetComposerId),
            unifiedModeStored: await storageReader.getComposerUnifiedMode(targetComposerId),
          };
        } catch (err) {
          report.verification = { delivered: false, error: String(err) };
        } finally {
          await storageReader.dispose();
        }
      }

      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(report, null, 2),
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
    })
  );
}

