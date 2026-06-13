/**
 * OpenClaw WebSocket Client
 * Connects to OpenClaw Gateway and receives real-time agent events
 * 
 * Configuration loaded from lib/config.js (openclaw-office.config.json / env vars)
 * Uses task status from DB instead of isDelegated flags.
 * WS NEVER auto-completes delegated tasks.
 */

import WebSocket from 'ws'
import crypto from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { eventBus, EVENTS } from './event-bus.js'
import { createRequest, updateRequest, getRequestById, findOldestReceived, findOldestIncomplete, addEvent, incrementMessages, fixPlaceholderEvents, getActiveTaskByAgent, getTaskByRequestId, updateTask, getTaskById } from './db.js'
import { AGENTS } from './workflow.js'
import { getConfig } from './config.js'

function getGatewayUrl() {
  return getConfig().gateway?.url || 'ws://127.0.0.1:18789'
}

function getGatewayToken() {
  return getConfig().gateway?.token || ''
}

/**
 * Load OpenClaw device identity for gateway authentication.
 * Returns { deviceId, publicKeyPem, privateKeyPem, operatorToken } or null.
 */
function loadDeviceIdentity() {
  const openclawDir = process.env.OPENCLAW_DIR || join(homedir(), '.openclaw')
  const devicePath = join(openclawDir, 'identity', 'device.json')
  const authPath = join(openclawDir, 'identity', 'device-auth.json')
  
  if (!existsSync(devicePath)) return null
  
  try {
    const device = JSON.parse(readFileSync(devicePath, 'utf-8'))
    let operatorToken = ''
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
      operatorToken = auth.tokens?.operator?.token || ''
    }
    return {
      deviceId: device.deviceId,
      publicKeyPem: device.publicKeyPem,
      privateKeyPem: device.privateKeyPem,
      operatorToken,
    }
  } catch (err) {
    console.error('[openclaw-ws] Failed to load device identity:', err.message)
    return null
  }
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

/**
 * Build and sign the device auth payload (v3 format).
 * Payload: v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
 */
function signDeviceAuth({ deviceId, privateKeyPem, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) {
  const payload = [
    'v3', deviceId, clientId, clientMode, role,
    scopes.join(','), String(signedAtMs), token || '',
    nonce, platform || '', deviceFamily || '',
  ].join('|')
  
  try {
    const key = crypto.createPrivateKey(privateKeyPem)
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key)
    return base64UrlEncode(sig)
  } catch (err) {
    console.error('[openclaw-ws] Failed to sign device auth:', err.message)
    return null
  }
}

/**
 * Extract raw public key bytes from PEM and encode as base64url.
 */
function publicKeyToRawBase64Url(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem)
  const spki = key.export({ type: 'spki', format: 'der' })
  // Ed25519 SPKI prefix is 12 bytes, raw key is the rest (32 bytes)
  const raw = spki.subarray(12)
  return base64UrlEncode(raw)
}

let deviceIdentity = null  // Loaded once on first connect
const DEVICE_CLIENT_ID = 'cli'
const DEVICE_CLIENT_MODE = 'cli'
const DEVICE_PLATFORM = 'linux'
const OPERATOR_SCOPES = ['operator.read']

let ws = null
let reconnectTimer = null
const sharedWsState = globalThis.__openclawOfficeWsState ??= {
  connected: false,
  currentRequestId: null,
  currentRunId: null,
}

let currentRequestId = sharedWsState.currentRequestId
let currentRunId = sharedWsState.currentRunId
let isConnected = sharedWsState.connected
let hasStartedStreaming = false
let animationTimers = []
let reconnectAttempts = 0
const MAX_RECONNECT_LOG = 3  // Only log first N reconnect failures

function setConnected(value) {
  isConnected = value
  sharedWsState.connected = value
}

function syncRequestState() {
  sharedWsState.currentRequestId = currentRequestId
  sharedWsState.currentRunId = currentRunId
}

function timeStr() {
  return new Date().toLocaleTimeString('en-US', { 
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
  })
}

function createDashboardEvent(requestId, state, agent, message) {
  if (!requestId) return null
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    requestId, state, agent,
    agentColor: AGENTS[agent]?.color || '#888',
    agentName: AGENTS[agent]?.name || agent,
    message,
    time: timeStr(),
    timestamp: Date.now(),
  }
  addEvent(event)
  eventBus.emit(EVENTS.WORKFLOW_EVENT, event)
  return event
}

function emitRequestUpdate(requestId) {
  if (!requestId) return
  const req = getRequestById(requestId)
  if (req) eventBus.emit(EVENTS.REQUEST_UPDATE, req)
}

function emitTaskUpdate(taskId) {
  if (!taskId) return
  const task = getTaskById(taskId)
  if (task) eventBus.emit(EVENTS.TASK_UPDATE, task)
}

function getToolLabel(toolName, args) {
  const name = toolName?.toLowerCase() || ''
  switch (name) {
    case 'read': return `📄 Reading: ${(args?.path || args?.file_path || 'file').split('/').pop()}`.slice(0, 60)
    case 'write': return `✍️ Writing: ${(args?.path || args?.file_path || 'file').split('/').pop()}`.slice(0, 60)
    case 'edit': return `📝 Editing: ${(args?.path || args?.file_path || 'file').split('/').pop()}`.slice(0, 60)
    case 'exec': return `💻 Exec: ${(args?.command || '').slice(0, 40)}`
    case 'web_search': return `🔍 Searching: ${(args?.query || 'web').slice(0, 40)}`
    case 'web_fetch': return `🌐 Fetching: ${(args?.url || 'URL').slice(0, 40)}`
    case 'browser': return `🖥️ Browser: ${args?.action || 'action'}`
    case 'sessions_spawn': return `🚀 Spawning sub-agent...`
    case 'cron': return `⏰ Cron: ${args?.action || 'action'}`
    case 'message': return `💬 Messaging...`
    case 'gateway': return `⚙️ Gateway: ${args?.action || 'action'}`
    default: return `🛠️ ${toolName || 'Tool'}`
  }
}

/**
 * Check if the current request's task is delegated (assigned to non-wickedman agent).
 * This replaces the old isDelegated flag.
 */
function isTaskDelegated(requestId) {
  if (!requestId) return false
  const task = getTaskByRequestId(requestId)
  if (!task) {
    // Fallback: check request.assignedTo
    const req = getRequestById(requestId)
    return req && req.assignedTo && req.assignedTo !== 'wickedman'
  }
  return task.assignedAgent && task.assignedAgent !== 'wickedman'
}

/**
 * Ensure we have a request to track.
 * ONLY adopts existing requests — never creates new ones.
 */
function ensureRequest() {
  if (currentRequestId) {
    const existing = getRequestById(currentRequestId)
    if (existing && existing.state !== 'completed') return currentRequestId
  }
  
  const pending = findOldestReceived()
  if (pending && (pending.state === 'received' || pending.state === 'analyzing' || pending.state === 'in_progress')) {
    currentRequestId = pending.id
    console.log(`[openclaw-ws] Adopted request: ${currentRequestId}`)
    return currentRequestId
  }
  
  const incomplete = findOldestIncomplete()
  if (incomplete) {
    currentRequestId = incomplete.id
    console.log(`[openclaw-ws] Adopted incomplete request: ${currentRequestId}`)
    return currentRequestId
  }
  
  console.log(`[openclaw-ws] No request to adopt`)
  return null
}

let lastUserMessage = null

function clearAnimationTimers() {
  animationTimers.forEach(t => clearTimeout(t))
  animationTimers = []
}

let firstToolSeen = false

function runCinematicAnimation(reqId) {
  clearAnimationTimers()
  firstToolSeen = false
  
  const req = getRequestById(reqId)
  if (!req) return
  
  const stateOrder = ['received', 'analyzing', 'task_created', 'assigned', 'in_progress', 'completed']
  const currentIdx = stateOrder.indexOf(req.state)
  
  let delay = 0
  
  if (currentIdx < 1) {
    delay += 800
    const t1 = setTimeout(() => {
      const r = getRequestById(reqId)
      if (!r || r.state === 'completed' || stateOrder.indexOf(r.state) >= 1) return
      updateRequest(reqId, { state: 'analyzing' })
      const freshContent = (r.content && r.content !== 'Processing...' ? r.content : lastUserMessage || '')
        .replace(/^\[Telegram[^\]]*\]\s*/s, '').replace(/\[message_id:\s*\d+\]\s*$/, '').trim()
      createDashboardEvent(reqId, 'analyzing', 'wickedman', `🔍 Analyzing: "${freshContent.slice(0, 50)}${freshContent.length > 50 ? '...' : ''}"`)
      emitRequestUpdate(reqId)
    }, delay)
    animationTimers.push(t1)
  }
  
  // Fallback: advance to in_progress after 8s if no tool call
  const tFallback = setTimeout(() => {
    const r = getRequestById(reqId)
    if (!r || r.state === 'completed' || r.state === 'in_progress') return
    if (firstToolSeen) return
    const agent = r.assignedTo || 'wickedman'
    updateRequest(reqId, { state: 'task_created', task: { title: (r.content || '').slice(0, 50), detail: r.content, targetAgent: agent } })
    createDashboardEvent(reqId, 'task_created', 'wickedman', `📋 Task created: "${(r.content || '').slice(0, 40)}"`)
    emitRequestUpdate(reqId)
    setTimeout(() => {
      updateRequest(reqId, { state: 'assigned', assignedTo: agent })
      createDashboardEvent(reqId, 'assigned', 'wickedman', `📧 Assigned to ${AGENTS[agent]?.emoji || '🤖'} ${AGENTS[agent]?.name || agent}`)
      emitRequestUpdate(reqId)
      setTimeout(() => {
        updateRequest(reqId, { state: 'in_progress', workStartedAt: Date.now() })
        // Also update task if exists
        const task = getTaskByRequestId(reqId)
        if (task && task.status !== 'in_progress' && task.status !== 'completed') {
          updateTask(task.id, { status: 'in_progress', startedAt: Date.now() })
          emitTaskUpdate(task.id)
        }
        createDashboardEvent(reqId, 'in_progress', agent, `⚡ ${AGENTS[agent]?.name || agent} working...`)
        emitRequestUpdate(reqId)
      }, 800)
    }, 800)
  }, 8000)
  animationTimers.push(tFallback)
}

function runDelegationAnimation(reqId, delegatedTo, taskDetail) {
  const agentInfo = AGENTS[delegatedTo] || {}
  const agentName = agentInfo.name || delegatedTo
  const agentEmoji = agentInfo.emoji || '🤖'
  
  updateRequest(reqId, { 
    state: 'task_created',
    task: { title: taskDetail.slice(0, 50), detail: taskDetail, targetAgent: delegatedTo }
  })
  createDashboardEvent(reqId, 'task_created', 'wickedman', `📋 Task: "${taskDetail.slice(0, 40)}${taskDetail.length > 40 ? '...' : ''}" → ${agentName}`)
  emitRequestUpdate(reqId)
  
  setTimeout(() => {
    updateRequest(reqId, { state: 'assigned', assignedTo: delegatedTo })
    createDashboardEvent(reqId, 'assigned', delegatedTo, `📧 Delegated to ${agentEmoji} ${agentName}`)
    emitRequestUpdate(reqId)
  }, 500)
  
  setTimeout(() => {
    updateRequest(reqId, { state: 'in_progress', workStartedAt: Date.now() })
    // Update task status
    const task = getTaskByRequestId(reqId)
    if (task) {
      updateTask(task.id, { status: 'in_progress', assignedAgent: delegatedTo, startedAt: Date.now() })
      emitTaskUpdate(task.id)
    }
    createDashboardEvent(reqId, 'in_progress', delegatedTo, `⚡ ${agentName} working...`)
    emitRequestUpdate(reqId)
  }, 1000)
}

/**
 * Complete wickedman's active task (only if NOT delegated)
 */
function completeWickedmanTask(reqId) {
  if (!reqId) return
  
  // Check if task is delegated — if so, NEVER auto-complete
  if (isTaskDelegated(reqId)) {
    console.log(`[openclaw-ws] Task is delegated — skipping auto-completion for ${reqId}`)
    return
  }
  
  const req = getRequestById(reqId)
  if (!req || req.state === 'completed') return
  
  // Complete request
  updateRequest(reqId, { state: 'completed', completedAt: Date.now() })
  
  // Complete task
  const task = getTaskByRequestId(reqId)
  if (task && task.status !== 'completed' && task.status !== 'failed') {
    updateTask(task.id, { status: 'completed', completedAt: Date.now() })
    emitTaskUpdate(task.id)
  }
  
  const freshReq = getRequestById(reqId) || req
  const taskTitle = freshReq.task?.title || (freshReq.content && freshReq.content !== 'Processing...' ? freshReq.content : lastUserMessage || '')
  const cleanTitle = (taskTitle || lastUserMessage || 'task').replace(/^\[Telegram[^\]]*\]\s*/s, '').replace(/\[message_id:\s*\d+\]\s*$/, '').trim()
  createDashboardEvent(reqId, 'completed', freshReq.assignedTo || 'wickedman', `✅ Done: "${cleanTitle.slice(0, 60)}${cleanTitle.length > 60 ? '...' : ''}"`)
  emitRequestUpdate(reqId)
  console.log(`[openclaw-ws] Completed request: ${reqId}`)
}

function handleAgentEvent(payload) {
  if (!payload) return
  const { stream, runId, data, sessionKey } = payload
  
  console.log(`[openclaw-ws] Agent event: stream=${stream} runId=${runId?.slice(0,8)} data=${JSON.stringify(data).slice(0,100)}`)
  
  if (runId && runId !== currentRunId) {
    currentRunId = runId
    hasStartedStreaming = false
    currentRequestId = null
    clearAnimationTimers()
    console.log(`[openclaw-ws] New run started: ${runId}`)
    
    const pending = findOldestReceived()
    if (pending && (pending.state === 'received' || pending.state === 'analyzing')) {
      currentRequestId = pending.id
      console.log(`[openclaw-ws] Pre-adopted request for new run: ${currentRequestId}`)
    }
  }
  
  // Lifecycle events
  if (stream === 'lifecycle') {
    const phase = data?.phase
    console.log(`[openclaw-ws] Lifecycle event: phase=${phase}`)
    
    if (phase === 'start') {
      let reqId = ensureRequest()
      
      if (!reqId) {
        const newReqId = `req_${Date.now()}`
        createRequest({
          id: newReqId,
          content: 'Processing...',
          from: 'Boss',
          state: 'received',
          assignedTo: 'wickedman',
          task: null,
          createdAt: Date.now(),
          source: 'websocket_lifecycle',
        })
        currentRequestId = newReqId
        reqId = newReqId
        incrementMessages('received')
        emitRequestUpdate(newReqId)
        console.log(`[openclaw-ws] Created silent placeholder: ${newReqId}`)
      } else {
        runCinematicAnimation(reqId)
      }
    }
    
    if (phase === 'end') {
      console.log(`[openclaw-ws] phase:end - currentRequestId=${currentRequestId}`)
      clearAnimationTimers()
      
      // Find request to complete
      let reqIdToComplete = currentRequestId
      if (!reqIdToComplete) {
        const pending = findOldestIncomplete()
        if (pending) {
          reqIdToComplete = pending.id
          console.log(`[openclaw-ws] Found incomplete request: ${reqIdToComplete}`)
        }
      }
      
      // Complete only if NOT delegated
      completeWickedmanTask(reqIdToComplete)
      
      currentRequestId = null
      currentRunId = null
      hasStartedStreaming = false
    }
  }
  
  // Job events (legacy compat)
  if (stream === 'job') {
    const state = data?.state
    console.log(`[openclaw-ws] Job event: state=${state}`)
    
    if (state === 'started') {
      ensureRequest()
    }
    
    if (state === 'done' || state === 'error' || state === 'aborted') {
      clearAnimationTimers()
      if (currentRequestId) {
        if (isTaskDelegated(currentRequestId)) {
          console.log(`[openclaw-ws] job:${state} but delegated — skipping completion`)
        } else {
          const req = getRequestById(currentRequestId)
          if (req && req.state !== 'completed') {
            completeWickedmanTask(currentRequestId)
          }
        }
        currentRequestId = null
        currentRunId = null
        hasStartedStreaming = false
      }
    }
  }
  
  // Tool events
  if (stream === 'tool') {
    const { phase, name, args } = data || {}
    console.log(`[openclaw-ws] Tool event: phase=${phase} name=${name}`)
    
    if (phase === 'start') {
      const reqId = ensureRequest()
      if (!reqId) return
      const req = getRequestById(reqId)
      
      // sessions_spawn → delegation
      if (name === 'sessions_spawn') {
        clearAnimationTimers()
        firstToolSeen = true
        const delegatedTo = args?.agentId || 'py'
        const taskDetail = args?.task || 'task'
        console.log(`[openclaw-ws] Delegation detected → ${delegatedTo}`)
        
        // Update task's assigned_agent
        const task = getTaskByRequestId(reqId)
        if (task) {
          updateTask(task.id, { assignedAgent: delegatedTo })
          emitTaskUpdate(task.id)
        }
        
        runDelegationAnimation(reqId, delegatedTo, taskDetail)
        return
      }
      
      // First non-spawn tool: advance to in_progress with wickedman
      if (!firstToolSeen) {
        firstToolSeen = true
        clearAnimationTimers()
        const agent = req?.assignedTo || 'wickedman'
        
        if (req && req.state !== 'in_progress' && req.state !== 'completed') {
          updateRequest(reqId, { state: 'in_progress', workStartedAt: Date.now(), assignedTo: agent })
          const task = getTaskByRequestId(reqId)
          if (task && task.status !== 'in_progress' && task.status !== 'completed') {
            updateTask(task.id, { status: 'in_progress', startedAt: Date.now() })
            emitTaskUpdate(task.id)
          }
          createDashboardEvent(reqId, 'in_progress', agent, `⚡ ${AGENTS[agent]?.name || agent} working...`)
          emitRequestUpdate(reqId)
        }
      } else if (req && req.state !== 'in_progress' && req.state !== 'completed') {
        clearAnimationTimers()
        updateRequest(reqId, { state: 'in_progress', workStartedAt: Date.now() })
        createDashboardEvent(reqId, 'in_progress', req?.assignedTo || 'wickedman', `⚡ Working...`)
        emitRequestUpdate(reqId)
      }
      
      const toolLabel = getToolLabel(name, args)
      createDashboardEvent(reqId, 'in_progress', req?.assignedTo || 'wickedman', toolLabel)
    }
  }
  
  // User messages
  if (stream === 'user') {
    const text = data?.text || data?.content || ''
    if (text && text.length > 0 && !text.startsWith('Read HEARTBEAT') && !text.includes('HEARTBEAT_OK') && !text.startsWith('/')) {
      lastUserMessage = text
      
      let cleanText = text
      const tgMatch = text.match(/\[Telegram[^\]]*\]\s*(.+)/s)
      if (tgMatch) cleanText = tgMatch[1].trim()
      cleanText = cleanText.replace(/\[message_id:\s*\d+\]\s*$/, '').trim()
      if (!cleanText || cleanText.length < 2 || cleanText.startsWith('System:') || cleanText.includes('[Queued')) return
      
      if (!currentRequestId) {
        const pending = findOldestReceived()
        if (pending) {
          currentRequestId = pending.id
          if (pending.content === 'Processing...' || !pending.content) {
            updateRequest(pending.id, { content: cleanText.slice(0, 200) })
            fixPlaceholderEvents(pending.id, cleanText)
          }
        } else {
          const content = cleanText.slice(0, 200)
          const newReqId = `req_${Date.now()}`
          createRequest({
            id: newReqId,
            content, from: 'Boss',
            state: 'received',
            assignedTo: 'wickedman',
            task: null,
            createdAt: Date.now(),
            source: 'websocket_user',
          })
          currentRequestId = newReqId
          incrementMessages('received')
          createDashboardEvent(newReqId, 'received', 'wickedman', `📥 Request from Boss: "${content.slice(0, 50)}${content.length > 50 ? '...' : ''}"`)
          emitRequestUpdate(newReqId)
        }
      }
    }
  }
  
  // Assistant streaming
  if (stream === 'assistant') {
    if (!hasStartedStreaming) {
      hasStartedStreaming = true
      const reqId = ensureRequest()
      if (!reqId) return
      const req = getRequestById(reqId)
      
      if (req && req.state !== 'in_progress' && req.state !== 'completed') {
        clearAnimationTimers()
        updateRequest(reqId, { state: 'in_progress' })
        const task = getTaskByRequestId(reqId)
        if (task && task.status !== 'in_progress' && task.status !== 'completed') {
          updateTask(task.id, { status: 'in_progress', startedAt: Date.now() })
          emitTaskUpdate(task.id)
        }
        const freshReq = getRequestById(reqId) || req
        const taskTitle = freshReq.task?.title || (freshReq.content && freshReq.content !== 'Processing...' ? freshReq.content : lastUserMessage || '')
        const cleanTitle = (taskTitle || lastUserMessage || 'message').replace(/^\[Telegram[^\]]*\]\s*/s, '').replace(/\[message_id:\s*\d+\]\s*$/, '').trim()
        createDashboardEvent(reqId, 'in_progress', freshReq?.assignedTo || 'wickedman', `✍️ Responding: "${cleanTitle.slice(0, 60)}${cleanTitle.length > 60 ? '...' : ''}"`)
        emitRequestUpdate(reqId)
      }
    }
  }
}

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log('[openclaw-ws] Already connected or connecting')
    return
  }
  
  if (reconnectAttempts <= MAX_RECONNECT_LOG) {
    console.log(`[openclaw-ws] Connecting to ${getGatewayUrl()}...`)
  }
  
  try {
    ws = new WebSocket(getGatewayUrl(), {
      headers: {
        'Authorization': `Bearer ${getGatewayToken()}`,
        'Origin': 'http://localhost:4200',
      }
    })
    
    ws.on('open', () => {
      if (reconnectAttempts <= MAX_RECONNECT_LOG) {
        console.log('[openclaw-ws] WebSocket open, waiting for challenge...')
      }
    })
    
    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString())
        
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          if (reconnectAttempts <= MAX_RECONNECT_LOG) {
            console.log('[openclaw-ws] Received challenge, sending connect...')
          }
          
          // Load device identity on first connect
          if (!deviceIdentity) {
            deviceIdentity = loadDeviceIdentity()
          }
          
          const nonce = msg.payload?.nonce || ''
          const connectParams = {
            minProtocol: 4, maxProtocol: 4,
            client: { id: DEVICE_CLIENT_ID, version: '1.0.0', platform: DEVICE_PLATFORM, mode: DEVICE_CLIENT_MODE },
            role: 'operator',
            scopes: OPERATOR_SCOPES,
            caps: [], commands: [], permissions: {},
            locale: 'en-US',
            userAgent: 'openclaw-office/0.1.0',
          }
          
          // Use device identity if available (required for local gateway)
          if (deviceIdentity) {
            const signedAtMs = Date.now()
            // Gateway token is required for auth — device identity handles device auth separately
            const token = deviceIdentity.operatorToken || getGatewayToken()
            const clientId = DEVICE_CLIENT_ID
            const clientMode = DEVICE_CLIENT_MODE
            const role = 'operator'
            const scopes = OPERATOR_SCOPES
            
            const signature = signDeviceAuth({
              deviceId: deviceIdentity.deviceId,
              privateKeyPem: deviceIdentity.privateKeyPem,
              clientId, clientMode, role, scopes, signedAtMs,
              token, nonce, platform: DEVICE_PLATFORM, deviceFamily: '',
            })
            
            connectParams.device = {
              id: deviceIdentity.deviceId,
              publicKey: publicKeyToRawBase64Url(deviceIdentity.publicKeyPem),
              signature,
              signedAt: signedAtMs,
              nonce,
            }
            connectParams.auth = { token }
          } else {
            // Fallback: token-only auth (may not work with newer gateways)
            connectParams.auth = { token: getGatewayToken() }
          }
          
          ws.send(JSON.stringify({
            type: 'req',
            id: 'connect-1',
            method: 'connect',
            params: connectParams,
          }))
          return
        }
        
        if (msg.id === 'connect-1' || (msg.type === 'res' && msg.method === 'connect')) {
          const success = msg.ok || msg.result || (!msg.error)
          if (success) {
            console.log('[openclaw-ws] ✓ Connected to OpenClaw Gateway')
            setConnected(true)
            reconnectAttempts = 0
          } else {
            if (reconnectAttempts < MAX_RECONNECT_LOG) {
              console.error('[openclaw-ws] Connect failed:', msg.error)
            } else if (reconnectAttempts === MAX_RECONNECT_LOG) {
              console.log('[openclaw-ws] Gateway unavailable — will keep retrying silently. Dashboard running in standalone mode.')
            }
            setConnected(false)
          }
          return
        }
        
        if (msg.type === 'event' && msg.event === 'agent') {
          if (!isConnected) { setConnected(true) }
          handleAgentEvent(msg.payload)
          return
        }
        
        if (msg.type === 'event' && msg.event === 'chat') {
          if (!isConnected) setConnected(true)
          const { state, runId } = msg.payload || {}
          console.log(`[openclaw-ws] Chat event: state=${state}`)
          
          if (state === 'delivered' || state === 'idle') {
            clearAnimationTimers()
            if (currentRequestId) {
              completeWickedmanTask(currentRequestId)
              currentRequestId = null
              currentRunId = null
              hasStartedStreaming = false
            }
          }
          return
        }
        
        if (msg.type === 'event' && (msg.event === 'tick' || msg.event === 'health')) return
        
        if (msg.type === 'event') {
          if (!isConnected) setConnected(true)
          console.log(`[openclaw-ws] Event: ${msg.event} payload=${JSON.stringify(msg.payload).slice(0,80)}`)
        }
        
      } catch (err) {
        console.error('[openclaw-ws] Parse error:', err.message)
      }
    })
    
    ws.on('close', (code, reason) => {
      if (reconnectAttempts < MAX_RECONNECT_LOG) {
        console.log(`[openclaw-ws] Disconnected: ${code} ${reason}`)
      }
      setConnected(false)
      ws = null
      clearAnimationTimers()
      scheduleReconnect()
    })
    
    ws.on('error', (err) => {
      console.error('[openclaw-ws] Error:', err.message)
      setConnected(false)
    })
    
  } catch (err) {
    console.error('[openclaw-ws] Connection failed:', err.message)
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectAttempts++
  // Exponential backoff: 5s, 10s, 20s, ... max 60s
  const delay = Math.min(5000 * Math.pow(2, Math.min(reconnectAttempts - 1, 4)), 60000)
  if (reconnectAttempts <= MAX_RECONNECT_LOG) {
    console.log(`[openclaw-ws] Reconnecting in ${delay / 1000}s...`)
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

export function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  clearAnimationTimers()
  if (ws) { ws.close(); ws = null }
  setConnected(false)
}

export function getStatus() {
  return {
    connected: sharedWsState.connected,
    url: getGatewayUrl(),
    currentRequestId: sharedWsState.currentRequestId,
    currentRunId: sharedWsState.currentRunId,
  }
}

export function setCurrentRequest(requestId) {
  currentRequestId = requestId
  syncRequestState()
}
export function getCurrentRequest() {
  return sharedWsState.currentRequestId
}
