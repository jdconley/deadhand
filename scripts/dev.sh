#!/bin/bash

# Development script to run all Deadhand components

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Deadhand development environment...${NC}"

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}Error: pnpm is not installed. Please install it first.${NC}"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    pnpm install
fi

# Build packages first
echo -e "${YELLOW}Building packages...${NC}"
pnpm build

# Start daemon in background with localhost-only mode
echo -e "${GREEN}Starting daemon...${NC}"
DEADHAND_LOCALHOST_ONLY=true pnpm --filter @deadhand/daemon dev &
DAEMON_PID=$!

# Wait for daemon to start
sleep 2

# Start web UI dev server
echo -e "${GREEN}Starting web UI dev server...${NC}"
pnpm --filter @deadhand/web dev &
WEB_PID=$!

# Print info
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deadhand development environment ready!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Daemon:  http://localhost:31337"
echo -e "Web UI:  http://localhost:5173"
echo ""
echo -e "${YELLOW}To test the extension:${NC}"
echo -e "  1. Open VS Code/Cursor in packages/extension"
echo -e "  2. Press F5 to launch Extension Development Host"
echo ""
echo -e "Press Ctrl+C to stop all processes"

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"
    kill $DAEMON_PID 2>/dev/null || true
    kill $WEB_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for processes
wait

