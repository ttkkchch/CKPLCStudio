import { application } from '@application'
import { loggerService } from '@logger'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { type BuiltinMcpServerName, BuiltinMcpServerNames } from '@shared/utils/mcp'

import BraveSearchServer from './braveSearch'
import { BrowserServer } from './browser'
import DiDiMcpServer from './didiMcp'
import DifyKnowledgeServer from './difyKnowledge'
import FetchServer from './fetch'
import { FileSystemServer, resolveFilesystemBaseDir } from './filesystem'
import MemoryServer from './memory'
import PythonServer from './python'
import ThinkingServer from './sequentialthinking'
import { TiaWorkspaceServer } from './tiaWorkspace'

const logger = loggerService.withContext('McpFactory')

export function createInMemoryMcpServer(
  name: BuiltinMcpServerName,
  args: string[] = [],
  envs: Record<string, string> = {}
): Server {
  logger.debug(`[MCP] Creating in-memory MCP server: ${name} with args: ${args} and envs: ${JSON.stringify(envs)}`)
  switch (name) {
    case BuiltinMcpServerNames.memory: {
      const envPath = envs.MEMORY_FILE_PATH
      return new MemoryServer(envPath).server
    }
    case BuiltinMcpServerNames.sequentialThinking: {
      return new ThinkingServer().server
    }
    case BuiltinMcpServerNames.braveSearch: {
      return new BraveSearchServer(envs.BRAVE_API_KEY).server
    }
    case BuiltinMcpServerNames.fetch: {
      return new FetchServer().server
    }
    case BuiltinMcpServerNames.filesystem: {
      return new FileSystemServer(resolveFilesystemBaseDir(args, envs)).server
    }
    case BuiltinMcpServerNames.difyKnowledge: {
      const difyKey = envs.DIFY_KEY
      return new DifyKnowledgeServer(difyKey, args).server
    }
    case BuiltinMcpServerNames.python: {
      return new PythonServer().server
    }
    case BuiltinMcpServerNames.didiMcp: {
      const apiKey = envs.DIDI_API_KEY
      return new DiDiMcpServer(apiKey).server
    }
    case BuiltinMcpServerNames.browser: {
      return new BrowserServer().server
    }
    case BuiltinMcpServerNames.tiaWorkspace: {
      return new TiaWorkspaceServer(envs.TIA_EXTRA_ROOTS).server
    }
    case BuiltinMcpServerNames.gxWorkspace: {
      // Same file/note toolset as tiaWorkspace, rooted at the GX workspace dir.
      return new TiaWorkspaceServer(envs.GX_EXTRA_ROOTS, application.getPath('feature.gx.workspace')).server
    }
    default:
      throw new Error(`Unknown in-memory MCP server: ${name}`)
  }
}
