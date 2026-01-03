import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Session, TranscriptEvent } from '../types';
import { getModeLabel } from '../types';
import styles from './TranscriptView.module.css';

interface TranscriptViewProps {
  session: Session;
  events: TranscriptEvent[];
  isLoading?: boolean;
}

function formatTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Get role from event payload */
function getRole(event: TranscriptEvent): 'user' | 'assistant' | 'tool' | 'system' | null {
  const payload = event.payload;
  
  if (event.type === 'tool_start' || event.type === 'tool_end') {
    return 'tool';
  }
  
  if ('role' in payload) {
    const role = String(payload.role).toLowerCase();
    if (role === 'user' || role === 'human') return 'user';
    if (role === 'assistant' || role === 'ai') return 'assistant';
    if (role === 'system') return 'system';
    if (role === 'tool' || role === 'function') return 'tool';
  }
  
  return null;
}

/** Get content from event payload */
function getContent(event: TranscriptEvent): string {
  const payload = event.payload;
  
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.message === 'string') return payload.message;
  
  return '';
}

/** Check if event is a tool call */
function isToolEvent(event: TranscriptEvent): boolean {
  return event.type === 'tool_start' || event.type === 'tool_end' || 'tool' in event.payload;
}

/** Tool event component */
function ToolEvent({ event }: { event: TranscriptEvent }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const payload = event.payload;
  const toolName = payload.tool as string || 'Tool';
  const args = payload.args as Record<string, unknown> | undefined;
  const result = payload.result as string | undefined;
  const isStart = event.type === 'tool_start';
  
  // Special rendering for Cursor-style question blocks (ask_question tool)
  const isAskQuestion = toolName === 'ask_question' && args && Array.isArray((args as any).questions);
  const askTitle = isAskQuestion && typeof (args as any).title === 'string' ? String((args as any).title) : null;
  const askQuestions = isAskQuestion ? ((args as any).questions as Array<any>) : [];
  
  return (
    <div className={`${styles.toolEvent} ${isStart ? styles.toolStart : styles.toolEnd}`}>
      <button 
        className={styles.toolHeader}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className={styles.toolIcon}>
          {isStart ? '⚡' : '✓'}
        </span>
        <span className={styles.toolName}>{isAskQuestion ? 'Questions' : toolName}</span>
        <span className={styles.toolStatus}>
          {isStart ? 'Running...' : 'Complete'}
        </span>
        <span className={styles.toolExpand}>
          {isExpanded ? '▼' : '▶'}
        </span>
      </button>
      
      {isExpanded && (
        <div className={styles.toolDetails}>
          {isAskQuestion && (
            <div className={styles.questionsBlock}>
              {askTitle && <div className={styles.questionsTitle}>{askTitle}</div>}
              <ol className={styles.questionsList}>
                {askQuestions.map((q, qIdx) => {
                  const prompt = typeof q?.prompt === 'string' ? q.prompt : '';
                  const options = Array.isArray(q?.options) ? q.options : [];
                  return (
                    <li key={q?.id ?? qIdx} className={styles.questionItem}>
                      <div className={styles.questionPrompt}>{prompt}</div>
                      {options.length > 0 && (
                        <ul className={styles.optionList}>
                          {options.map((opt: any, optIdx: number) => {
                            const label = typeof opt?.label === 'string' ? opt.label : '';
                            const letter = String.fromCharCode(65 + optIdx); // A, B, C...
                            return (
                              <li key={opt?.id ?? optIdx} className={styles.optionItem}>
                                <span className={styles.optionLetter}>{letter}</span>
                                <span className={styles.optionLabel}>{label}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          {args && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>Arguments</div>
              <pre className={styles.toolCode}>
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>Result</div>
              <pre className={styles.toolCode}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Chat message component */
function ChatMessage({ event }: { event: TranscriptEvent }) {
  const role = getRole(event);
  const content = getContent(event);
  const model = event.payload.model as string | undefined;
  
  if (!content && !isToolEvent(event)) {
    return null;
  }
  
  if (isToolEvent(event)) {
    return <ToolEvent event={event} />;
  }
  
  const isUser = role === 'user';
  const isAssistant = role === 'assistant';
  const isSystem = role === 'system';
  
  return (
    <div className={`${styles.message} ${isUser ? styles.userMessage : ''} ${isAssistant ? styles.assistantMessage : ''} ${isSystem ? styles.systemMessage : ''}`}>
      <div className={styles.messageHeader}>
        <span className={styles.messageRole}>
          {isUser ? 'You' : isAssistant ? 'Assistant' : isSystem ? 'System' : 'Message'}
        </span>
        {model && <span className={styles.messageModel}>{model}</span>}
        <span className={styles.messageTime}>{formatTime(event.ts)}</span>
      </div>
      <div className={styles.messageContent}>
        {isUser ? (
          // User messages: plain text
          <div className={styles.userContent}>{content}</div>
        ) : (
          // Assistant/system messages: markdown
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ className, children, ...props }) => {
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !match && !String(children).includes('\n');
                
                if (isInline) {
                  return <code className={styles.inlineCode} {...props}>{children}</code>;
                }
                
                return (
                  <div className={styles.codeBlock}>
                    {match && <div className={styles.codeLanguage}>{match[1]}</div>}
                    <pre className={styles.codeContent}>
                      <code className={className} {...props}>{children}</code>
                    </pre>
                  </div>
                );
              },
              p: ({ children }) => <p className={styles.paragraph}>{children}</p>,
              ul: ({ children }) => <ul className={styles.list}>{children}</ul>,
              ol: ({ children }) => <ol className={styles.list}>{children}</ol>,
              li: ({ children }) => <li className={styles.listItem}>{children}</li>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className={styles.link}>
                  {children}
                </a>
              ),
              blockquote: ({ children }) => (
                <blockquote className={styles.blockquote}>{children}</blockquote>
              ),
              h1: ({ children }) => <h1 className={styles.heading}>{children}</h1>,
              h2: ({ children }) => <h2 className={styles.heading}>{children}</h2>,
              h3: ({ children }) => <h3 className={styles.heading}>{children}</h3>,
              h4: ({ children }) => <h4 className={styles.heading}>{children}</h4>,
              table: ({ children }) => (
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>{children}</table>
                </div>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}

/** Raw event fallback for unknown event types */
function RawEvent({ event }: { event: TranscriptEvent }) {
  return (
    <div className={styles.rawEvent}>
      <div className={styles.rawHeader}>
        <span className={styles.rawType}>{event.type}</span>
        <span className={styles.rawTime}>{formatTime(event.ts)}</span>
      </div>
      <pre className={styles.rawContent}>
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </div>
  );
}

export function TranscriptView({ 
  session, 
  events, 
  isLoading = false,
}: TranscriptViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const showEmpty = events.length === 0;

  // Determine the appropriate empty state message
  const getEmptyStateContent = () => {
    if (isLoading) {
      return {
        title: 'Loading transcript...',
        subtitle: null,
        showSpinner: true,
      };
    }
    
    if (session.status === 'active') {
      return {
        title: 'Waiting for transcript events',
        subtitle: 'Messages will appear here as the conversation progresses',
        showSpinner: true,
      };
    }
    
    // Session is idle/ended but no events - likely a capture issue
    return {
      title: 'No transcript events captured',
      subtitle: 'The extension may not have captured this session\'s transcript. Try starting a new conversation in Cursor.',
      showSpinner: false,
    };
  };

  const emptyState = getEmptyStateContent();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerTitleGroup}>
          <h2 className={styles.title}>{session.title || 'Untitled session'}</h2>
          {(session.model || session.mode) && (
            <div className={styles.headerMeta}>
              {session.model && <span className={styles.modelChip}>{session.model}</span>}
              {session.mode && <span className={styles.modeChip}>{getModeLabel(session.mode)}</span>}
            </div>
          )}
        </div>
        <span className={`${styles.status} ${styles[session.status]}`}>
          {session.status}
        </span>
      </div>

      <div className={styles.chatContainer}>
        {showEmpty ? (
          <div className={styles.empty}>
            {emptyState.showSpinner && <div className={styles.spinner} />}
            <p>{emptyState.title}</p>
            {emptyState.subtitle && (
              <p className={styles.emptySubtitle}>{emptyState.subtitle}</p>
            )}
          </div>
        ) : (
          <div className={styles.chatMessages}>
            {events.map((event) => {
              const role = getRole(event);
              const content = getContent(event);
              const isTool = isToolEvent(event);
              
              // Render tool events
              if (isTool) {
                return <ToolEvent key={event.eventId} event={event} />;
              }
              
              // Render chat messages
              if (role && content) {
                return <ChatMessage key={event.eventId} event={event} />;
              }
              
              // Fallback: render raw for unknown events with content
              if (Object.keys(event.payload).length > 0) {
                return <RawEvent key={event.eventId} event={event} />;
              }
              
              return null;
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
