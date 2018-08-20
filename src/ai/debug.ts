import { DebugProtocol as DP } from 'vscode-debugprotocol'
import { objToMap, uuid, merge } from '../support/utils'
import getDebugConfig from '../ai/get-debug-config'
import * as extensions from '../core/extensions'
import { RPCServer } from '../core/extensions'
import debugUI from '../components/debugger'
import { action } from '../core/neovim'

type ThreadsRes = DP.ThreadsResponse['body']
type StackRes = DP.StackTraceResponse['body']
type ScopesRes = DP.ScopesResponse['body']
type VarRes = DP.VariablesResponse['body']
type Threads = DP.Thread[]
type StackFrames = DP.StackFrame[]
type Scopes = DP.Scope[]
type Variables = DP.Variable[]

interface DebuggerState {
  id: string
  type: string
  activeThread: number
  activeStack: number
  activeScope: number
  threads: Threads
  stackFrames: StackFrames
  scopes: Scopes
  variables: Variables
}

interface Debugger extends DebuggerState {
  rpc: RPCServer
}

const Refresher = (dbg: extensions.RPCServer) => ({
  threads: async () => {
    const { threads }: ThreadsRes = await dbg.sendRequest('threads')
    debugUI.updateState({ threads })
    return threads
  },
  stackFrames: async (threadId: number) => {
    const { stackFrames }: StackRes = await dbg.sendRequest('stackTrace', { threadId })
    debugUI.updateState({ stackFrames })
    return stackFrames
  },
  scopes: async (frameId: number) => {
    const { scopes }: ScopesRes = await dbg.sendRequest('scopes', { frameId })
    debugUI.updateState({ scopes })
    return scopes
  },
  variables: async (variablesReference: number) => {
    const { variables }: VarRes = await dbg.sendRequest('variables', { variablesReference })
    debugUI.updateState({ variables })
    return variables
  },
})

const debuggers = new Map<string, Debugger>()
let activeDebugger = 'lolnope'

// TODO: put these in separate functions? i think we may
// be calling these from the UI as well
action('debug-next', () => {
  const dbg = debuggers.get(activeDebugger)
  if (!dbg) return
  dbg.rpc.sendRequest('next', { threadId: dbg.activeThread })
})

action('debug-continue', () => {
  const dbg = debuggers.get(activeDebugger)
  if (!dbg) return
  dbg.rpc.sendRequest('continue', { threadId: dbg.activeThread })
})

const listActiveDebuggers = () => [...debuggers.values()]
  .map(d => ({ id: d.id, type: d.type }))

export const switchActiveDebugger = (id: string) => {
  if (!debuggers.has(id)) return false
  activeDebugger = id
  const { activeThread, activeStack, activeScope } = debuggers.get(id)!

  debugUI.updateState({
    activeDebugger,
    activeThread,
    activeStack,
    activeScope,
  })

  return true
}

// type Breakpoint = DP.SetBreakpointsRequest['arguments']

    // setBreakpoints for every source file with breakpoints,
    // setFunctionBreakpoints if the debug adapter supports function breakpoints,
    // setExceptionBreakpoints if the debug adapter supports any exception options,
    // configurationDoneRequest to indicate the end of the configuration sequence.

// const breakpoints = new Map<string, any>()
// const functionBreakpoints = new Map<string, any>()
// const exceptionBreakpoints = new Map<string, any>()

export const userSelectStack = async (frameId: number) => {
  const dbg = debuggers.get(activeDebugger)
  if (!dbg) return console.error('no current debugger found. this is a problem because we already have the debug context present in the UI.')

  const refresh = Refresher(dbg.rpc)
  const scopes = await refresh.scopes(frameId)
  debugUI.updateState({ activeScope: scopes[0].variablesReference })
  return refresh.variables(scopes[0].variablesReference)
}

export const userSelectScope = async (variablesReference: number) => {
  const dbg = debuggers.get(activeDebugger)
  if (!dbg) return console.error('no current debugger found. this is a problem because we already have the debug context present in the UI.')

  return Refresher(dbg.rpc).variables(variablesReference)
}

// TODO: this function should add a debugger entry if it does not exist
// should not error if a debugger does not exist
const updateDebuggerState = (id: string, state: Partial<Debugger>) => {
  const dbg = debuggers.get(id) || {} as Debugger

  const { rpc, ...next } = merge(dbg, state)
  debuggers.set(id, { rpc, ...next })

  if (id !== activeDebugger) return
  debugUI.updateState({ next, debuggers: listActiveDebuggers() })
}

export const start = async (type: string) => {
  console.warn(`starting debugger: ${type}`)

  const dbg: Debugger = {
    type,
    id: uuid(),
    activeThread: -1,
    activeStack: -1,
    activeScope: -1,
    threads: [],
    stackFrames: [],
    scopes: [],
    variables: [],
    rpc: await extensions.start.debug(type),
  }

  const features = new Map<string, any>()
  const refresh = Refresher(dbg.rpc)

  dbg.rpc.onNotification('stopped', async (m: DP.StoppedEvent['body']) => {
    // TODO: i think on this notification we SOMETIMES get 'threadId'
    // how do we use 'activeThread'???

    // how does it work in VSCode when the user selects a different thread?
    // i don't think it makes any difference in the stopped breakpoints???
    // 
    // i guess i'm a noob at debuggers - not sure how you can switch between
    // threads on a breakpoint. isn't a breakpoint per thread??
    console.log('DEBUGGER STOPPED:', m)
    // TODO: do something with breakpoint 'reason'
    const targetThread = m.threadId || dbg.activeThread

    await refresh.threads()
    const stackFrames = await refresh.stackFrames(targetThread)
    const scopes = await refresh.scopes(stackFrames[0].id)
    await refresh.variables(scopes[0].variablesReference)

    debugUI.updateState({
      activeThread: targetThread,
      activeStack: stackFrames[0].id,
      activeScope: scopes[0].variablesReference,
    })
  })

  // TODO: this notification is optional
  // if this does not set the active thread, then assign the first thread
  // from 'threads' request/response?
  dbg.rpc.onNotification('thread', (m: DP.ThreadEvent['body']) => {
    console.log('THREAD:', m)
    updateDebuggerState(dbg.id, { activeThread: m.threadId })
    // request: 'threads'
  })

  dbg.rpc.onNotification('terminated', () => {
    console.log('YOU HAVE BEEN TERMINATED')
  })

  dbg.rpc.onNotification('initialized', async () => {
    console.log('INITIALIZED! SEND DA BREAKPOINTS!')
    console.log(features)

    // TODO: need to call this request once per source!
    // multiple sources == multiple calls
    const breakpointsRequest: DP.SetBreakpointsRequest['arguments'] = {
      source: {
        name: 'asunc.js',
        path: '/Users/a/proj/playground/asunc.js',
      },
      breakpoints: [
        // TODO: support the other thingies (see interface for other options)
        { line: 10 }
      ]
    }

    const breakpointsResponse = await dbg.rpc.sendRequest('setBreakpoints', breakpointsRequest)
    console.log('BRSK:', breakpointsResponse)
    // TODO: send function breakpoints
    // TODO: send exception breakpoints

    await dbg.rpc.sendRequest('configurationDone')
    console.log('CONFIG DONE')
  })

  dbg.rpc.onNotification('capabilities', ({ capabilities }) => {
    objToMap(capabilities, features)
  })

  dbg.rpc.onNotification('loadedSource', (_m) => {
    // TODO: wat i do wit dis?
  })

  dbg.rpc.onNotification('output', data => {
    if (data.category === 'console' || data.category === 'stderr') console.log(type, data.output)
  })

  const initRequest: DP.InitializeRequest['arguments'] = {
    adapterID: type,
    clientID: 'veonim',
    clientName: 'Veonim',
    linesStartAt1: false,
    columnsStartAt1: false,
    pathFormat: 'path',
    locale: 'en',
  }

  const supportedCapabilities = await dbg.rpc.sendRequest('initialize', initRequest)
  // TODO: what do with DEEZ capabilities??
  // use capabilities to determine what kind of breakpoints to send, etc.
  // for example: log breakpoints that are not supported by all debuggers
  objToMap(supportedCapabilities, features)

  await dbg.rpc.sendRequest('launch', getDebugConfig(type))
  const { threads }: ThreadsRes = await dbg.rpc.sendRequest('threads')

  merge(dbg, {
    threads,
    activeThread: (threads[0] || {}).id || -1,
  })

  updateDebuggerState(dbg.id, dbg)
  activeDebugger = dbg.id
}
