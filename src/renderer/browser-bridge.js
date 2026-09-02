// Guard: skip shim entirely when running inside Electron (preload already
// defined window.cth via contextBridge). Only install in a plain browser.
if (typeof window.cth !== 'undefined') { /* Electron — preload handles IPC */ } else
(() => {
  const INVOKE_CHANNELS = {
  "spawnPty": "pty:spawn",
  "writePty": "pty:write",
  "resizePty": "pty:resize",
  "redrawPty": "pty:redraw",
  "killPty": "pty:kill",
  "listPtys": "pty:list",
  "resolveSessionCwd": "session:resolveCwd",
  "chooseFolder": "dialog:chooseFolder",
  "openTerminalAt": "terminal:openAtFolder",
  "copyToClipboard": "app:copyToClipboard",
  "readClipboard": "app:readClipboard",
  "getConfig": "config:get",
  "updateConfig": "config:update",
  "setAgentTokenCap": "config:setAgentTokenCap",
  "ensureHarnessHome": "config:ensureHome",
  "changeHome": "config:changeHome",
  "listDir": "fs:listDir",
  "readFile": "fs:readFile",
  "readBinary": "fs:readBinary",
  "writeFile": "fs:writeFile",
  "statAbs": "fs:statAbs",
  "revealPath": "fs:revealPath",
  "gitIsRepo": "git:isRepo",
  "gitMainRepo": "git:mainRepo",
  "gitBranch": "git:branch",
  "gitStatus": "git:status",
  "gitLog": "git:log",
  "gitBranches": "git:branches",
  "gitAheadBehind": "git:aheadBehind",
  "gitDiff": "git:diff",
  "gitLogGraph": "git:logGraph",
  "gitCommitFiles": "git:commitFiles",
  "gitShowFile": "git:showFile",
  "gitCompareRefs": "git:compareRefs",
  "gitWorktrees": "git:worktrees",
  "gitCheckout": "git:checkout",
  "hiveRegistry": "hive:registry",
  "hivePatchAgentRole": "hive:patchAgentRole",
  "hiveRenameAgent": "hive:renameAgent",
  "hiveSetAgentHold": "hive:setAgentHold",
  "hiveBoard": "hive:board",
  "hiveTasks": "hive:tasks",
  "hiveLog": "hive:log",
  "hiveMemory": "hive:memory",
  "hiveInbox": "hive:inbox",
  "hiveMessages": "hive:messages",
  "hiveAgentDirectory": "hive:agentDirectory",
  "hiveTouchedLedger": "hive:getTouchedLedger",
  "listWorkers": "workers:list",
  "stopWorker": "workers:stop",
  "respawnAgent": "agent:respawn",
  "openHumanQA": "tasks:openHumanQA",
  "answerHumanQA": "tasks:answerHumanQA",
  "dismissHumanQA": "tasks:dismissHumanQA",
  "memoryStatus": "hive:memoryStatus",
  "toolsStatus": "tools:status",
  "heroPayload": "hero:payload",
  "skillsLocal": "skills:local",
  "skillsCatalog": "skills:catalog",
  "skillsInstall": "skills:install",
  "skillsUninstall": "skills:uninstall",
  "skillsReveal": "skills:reveal",
  "searchMemory": "hive:searchMemory",
  "memoryWakeUp": "hive:memoryWakeUp",
  "mineNow": "hive:mineNow",
  "reflectNow": "memory:reflectNow",
  "kgStatus": "kg:status",
  "kgList": "kg:list",
  "kgSearch": "kg:search",
  "kgGet": "kg:get",
  "kgRemove": "kg:remove",
  "kgAddFiles": "kg:addFiles",
  "kgIngestFiles": "kg:ingestFiles",
  "attachFiles": "dialog:attachFiles",
  "saveClipboardImage": "clipboard:saveImage",
  "historyAdd": "history:add",
  "historyList": "history:list",
  "historySearch": "history:search",
  "hiveSend": "hive:send",
  "drainPendingHires": "hire:drainPending",
  "importHireFiles": "hire:openFile",
  "confirmClose": "app:confirmClose",
  "cancelClose": "app:cancelClose",
  "newFloor": "window:newFloor",
  "startClosingTime": "app:startClosingTime",
  "cancelClosingTime": "app:cancelClosingTime",
  "resetAll": "app:resetAll",
  "agentUsage": "hive:agentUsage",
  "agentContext": "hive:agentContext",
  "telemetryUsage": "telemetry:usage",
  "telemetrySpans": "telemetry:spans",
  "telemetrySnapshot": "telemetry:snapshot",
  "setBreakerState": "control:setBreakerState",
  "controlPause": "control:pause",
  "controlAutoDelivery": "control:autoDelivery",
  "controlResume": "control:resume",
  "controlGateTool": "control:gateTool",
  "controlSteer": "control:steer",
  "controlHalt": "control:halt",
  "controlSnapshot": "control:snapshot",
  "hiveAddTask": "hive:addTask",
  "hivePatchTask": "hive:patchTask",
  "hiveDeleteTask": "hive:deleteTask",
  "listMissions": "missions:list",
  "saveMissions": "missions:save",
  "textSearch": "hive:textSearch",
  "githubIssues": "github:issues",
  "githubCIRuns": "github:ciRuns",
  "setNotifications": "app:setNotifications",
  "openExternal": "app:openExternal",
  "setLoginItem": "app:setLoginItem",
  "hiveSetArchived": "hive:setArchived",
  "slackStart": "slack:start",
  "slackStop": "slack:stop",
  "slackStatus": "slack:status",
  "slackReply": "slack:reply",
  "slackReplyScriptPath": "slack:replyScriptPath",
  "slackSetConfig": "slack:setConfig",
  "webhookStart": "webhook:start",
  "webhookStop": "webhook:stop",
  "webhookStatus": "webhook:status",
  "webhookGenerateSecret": "webhook:generateSecret",
  "webhookSetConfig": "webhook:setConfig",
  "getContextTrigger": "triggers:getContext",
  "setContextTrigger": "triggers:setContext",
  "listWebhooks": "webhooks:list",
  "saveWebhooks": "webhooks:save",
  "deleteWebhook": "webhooks:delete",
  "generateWebhookSecret": "webhooks:generateSecret",
  "webhooksStatus": "webhooks:status",
  "getOrgTrigger": "org:getTrigger",
  "setOrgTrigger": "org:setTrigger",
  "getSyncStatus": "sync:getStatus",
  "setSyncRemote": "sync:setRemote",
  "syncNow": "sync:now",
  "listProfiles": "profiles:list",
  "currentProfile": "profiles:current",
  "createProfile": "profiles:create",
  "launchProfile": "profiles:launch",
  "deleteProfile": "profiles:delete",
  "joinHive": "sync:joinHive",
  "isSafeRemoteUrl": "sync:isSafeRemote",
  "ldaList": "lda:list",
  "ldaUpsert": "lda:upsert",
  "ldaRemove": "lda:remove",
  "ldaHealth": "lda:health",
  "ldaInvoke": "lda:invoke",
  "ldaSetApiKey": "lda:setApiKey",
  "ldaRemoveApiKey": "lda:removeApiKey",
  "ldaHasApiKey": "lda:hasApiKey",
  "profileSetApiKey": "profile:setApiKey",
  "profileRemoveApiKey": "profile:removeApiKey",
  "profileHasApiKey": "profile:hasApiKey",
  "profileIsSafeUrl": "profile:isSafeUrl",
  "shellsSnapshot": "fleet:shellsSnapshot",
  "rateLimitsSnapshot": "fleet:rateLimitsSnapshot",
  "governorSnapshot": "fleet:governorSnapshot",
  "setGovernorOverride": "governor:setOverride",
  "listTriggerHistory": "triggerHistory:list",
  "decideTriggerHistory": "triggerHistory:decide",
  "clearTriggerHistory": "triggerHistory:clear",
  "freeflowSetConfig": "freeflow:setConfig",
  "freeflowTranscribe": "freeflow:transcribe",
  "integrationsList": "integrations:list",
  "integrationsTemplates": "integrations:templates",
  "integrationsUpsert": "integrations:upsert",
  "integrationsSetSecret": "integrations:setSecret",
  "integrationsRemove": "integrations:remove",
  "integrationsTest": "integrations:test",
  "providerKeySet": "providerKey:set",
  "providerKeyHas": "providerKey:has",
  "providerKeyClear": "providerKey:clear",
  "realtimeHasOpenAiKey": "realtime:hasKey",
  "realtimeMintToken": "realtime:mintToken",
  "realtimeAction": "realtime:action",
  "realtimeActionConfirm": "realtime:action:confirm",
  "realtimeActionCancel": "realtime:action:cancel",
  "realtimeSetSessionLive": "realtime:setSessionLive",
  "realtimeDrainCompletions": "realtime:drainCompletions",
  "realtimeWaitFor": "realtime:waitFor",
  "appInfo": "app:info",
  "openInBrowser": "app:openInBrowser",
  "rosterWrite": "roster:write",
  "updateCurrent": "update:current",
  "updateRestartAndInstall": "update:restartAndInstall",
  "updateCheckNow": "update:checkNow",
  "updateDownload": "update:download",
  "updateOpenRelease": "update:openRelease",
  "updateSimulate": "update:simulate"
};
  const EVENT_CHANNELS = {
  "onHiveHookEvent": "hive:hookEvent",
  "onHiveContextUpdate": "hive:contextUpdate",
  "onHiveMessage": "hive:message",
  "onHiveEnqueue": "hive:enqueueToAgent",
  "onHiveAgentSpawned": "hive:agentSpawned",
  "onHiveAgentArchived": "hive:agentArchived",
  "onHiveTerminalHandoff": "hive:terminalHandoff",
  "onTouchedLedger": "hive:touchedUpdate",
  "onHireImport": "hire:import",
  "onHireError": "hire:error",
  "onCloseRequested": "app:closeRequested",
  "onPowerResume": "power:resume",
  "onClosingTime": "app:closingTime",
  "onTelemetryEvent": "telemetry:event",
  "onBreakerState": "control:breakerState",
  "onApprovalRequest": "control:approvalRequest",
  "onMissionsUpdated": "missions:updated",
  "onAutoCompact": "mission:autoCompact",
  "onSlackMessage": "slack:incomingMessage",
  "onContextTrigger": "trigger:context",
  "onActiveShells": "fleet:shells",
  "onRateLimitsUpdate": "hive:rateLimitsUpdate",
  "onGovernorMode": "hive:governorMode",
  "onTriggerHistoryUpdated": "triggerHistory:updated",
  "onRealtimeCompletion": "realtime:completion",
  "onRealtimeFloorDelta": "realtime:floorDelta",
  "onRealtimeEnqueue": "realtime:enqueue",
  "onUpdateStatus": "update:status"
};
  const BRIDGE_TIMEOUT_MS = 15000;
  const RETRY_BASE_MS = 500;
  const RETRY_MAX_MS = 5000;

  let socket = null;
  let connected = false;
  let retryDelay = RETRY_BASE_MS;
  let nextRequestId = 1;

  const pendingRequests = new Map();
  const outgoingQueue = [];
  const subscriptions = new Map();

  const logPrefix = '[browser-bridge]';
  const warn = (...args) => console.warn(logPrefix, ...args);
  const info = (...args) => console.info(logPrefix, ...args);
  const error = (...args) => console.error(logPrefix, ...args);
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const browserPlatform = nav?.userAgentData?.platform ?? nav?.platform ?? 'browser';
  const browserArch = nav?.userAgentData?.architecture
    ?? (nav?.userAgent?.toLowerCase().includes('arm') ? 'arm' : 'unknown');

  const unsupportedError = (method) => {
    const message = `${method} is not available in the browser bridge yet`;
    warn(message);
    return new Error(message);
  };

  function sendSerialized(serialized) {
    if (connected && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(serialized);
    } else {
      outgoingQueue.push(serialized);
    }
  }

  function sendEnvelope(payload) {
    try {
      sendSerialized(JSON.stringify(payload));
    } catch (err) {
      error('failed to serialize message', err);
    }
  }

  function flushQueue() {
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return;
    while (outgoingQueue.length > 0) {
      socket.send(outgoingQueue.shift());
    }
  }

  function resubscribeAll() {
    for (const [channel, state] of subscriptions) {
      if (state.handlers.size > 0) {
        sendEnvelope({ type: 'subscribe', channel });
        state.active = true;
      }
    }
  }

  function makeError(message, detail) {
    const err = new Error(message);
    if (detail && typeof detail === 'object') {
      if ('code' in detail) {
        err.code = detail.code;
      }
      if (detail.stack) {
        err.stack = detail.stack;
      }
    }
    return err;
  }

  function handleMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      error('failed to parse message', err);
      return;
    }

    switch (data.type) {
      case 'hello':
        resubscribeAll();
        return;
      case 'invoke-result': {
        const entry = pendingRequests.get(data.id);
        if (!entry) { warn('invoke-result for unknown id', data.id); return; }
        info('invoke ←', data.id, entry.channel, data.ok ? 'ok' : ('error: ' + (data.error?.message ?? '?')));
        pendingRequests.delete(data.id);
        clearTimeout(entry.timer);
        if (data.ok) {
          entry.resolve(data.value);
        } else {
          entry.reject(makeError(data.error?.message ?? `Invoke ${entry.channel} failed`, data.error));
        }
        return;
      }
      case 'event': {
        const state = subscriptions.get(data.channel);
        if (!state || state.handlers.size === 0) return;
        const args = Array.isArray(data.args)
          ? data.args
          : (typeof data.args === 'undefined' ? [] : [data.args]);
        for (const handler of Array.from(state.handlers)) {
          try { handler(...args); } catch (err) { error('handler threw', err); }
        }
        return;
      }
      case 'error':
        warn('main process reported error:', data.message);
        return;
      case 'pong':
        return;
      default:
        warn('unknown message type:', data.type);
    }
  }

  function rejectAllPending(err) {
    for (const entry of pendingRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pendingRequests.clear();
  }

  function scheduleReconnect() {
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(Math.round(retryDelay * 1.5), RETRY_MAX_MS);
  }

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/bridge`;
    info('connecting to', url);
    try {
      socket = new WebSocket(url);
    } catch (err) {
      error('socket creation failed', err);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      connected = true;
      retryDelay = RETRY_BASE_MS;
      info('connected');
      flushQueue();
      resubscribeAll();
    });

    socket.addEventListener('message', handleMessage);

    socket.addEventListener('close', () => {
      if (connected) warn('connection closed');
      connected = false;
      socket = null;
      rejectAllPending(new Error('Browser bridge disconnected'));
      scheduleReconnect();
    });

    socket.addEventListener('error', (err) => {
      error('socket error', err);
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
    });
  }

  connect();

  function invokeChannel(channel, args) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      const timer = setTimeout(() => {
        if (!pendingRequests.has(id)) return;
        pendingRequests.delete(id);
        reject(new Error(`Timed out invoking ${channel}`));
      }, BRIDGE_TIMEOUT_MS);

      pendingRequests.set(id, { resolve, reject, timer, channel });
      info('invoke →', id, channel);
      sendEnvelope({ type: 'invoke', id, channel, args: Array.isArray(args) ? args : [] });
    });
  }

  function subscribeChannel(channel, handler) {
    if (typeof handler !== 'function') {
      warn('subscribe expected function for', channel);
      return () => {};
    }
    let state = subscriptions.get(channel);
    if (!state) {
      state = { handlers: new Set(), active: false };
      subscriptions.set(channel, state);
    }
    state.handlers.add(handler);
    if (connected && !state.active) {
      sendEnvelope({ type: 'subscribe', channel });
      state.active = true;
    }
    return () => {
      const current = subscriptions.get(channel);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        subscriptions.delete(channel);
        if (connected) {
          sendEnvelope({ type: 'unsubscribe', channel });
        }
      }
    };
  }

  function registerInvokeMethods(target, mapping) {
    for (const [name, channel] of Object.entries(mapping)) {
      if (name in target) continue;
      target[name] = (...args) => invokeChannel(channel, args);
    }
  }

  function registerEventMethods(target, mapping) {
    for (const [name, channel] of Object.entries(mapping)) {
      if (name in target) continue;
      target[name] = (cb) => subscribeChannel(channel, (...args) => cb(...args));
    }
  }

  const cth = {
    version: 'browser',
    readClipboardSync: () => '',
    rosterReadSync: () => null
  };

  registerInvokeMethods(cth, INVOKE_CHANNELS);
  registerEventMethods(cth, EVENT_CHANNELS);

  cth.pathForFile = (file) => {
    if (file && typeof file === 'object') {
      if (typeof file.path === 'string' && file.path.length > 0) {
        return file.path;
      }
      if (typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0) {
        warn('pathForFile is not supported in the browser bridge; returning relative path only');
        return file.webkitRelativePath;
      }
      if (typeof file.name === 'string') {
        warn('pathForFile is not supported in the browser bridge; returning file name only');
        return file.name;
      }
    }
    warn('pathForFile is not available in the browser bridge; returning empty string');
    return '';
  };

  cth.platform = browserPlatform;
  cth.arch = browserArch;

  const unsupportedAsync = (method) => (...args) => {
    const err = unsupportedError(method);
    return Promise.reject(err);
  };

  cth.spawnPty = unsupportedAsync('spawnPty');
  cth.writePty = unsupportedAsync('writePty');
  cth.resizePty = unsupportedAsync('resizePty');
  cth.redrawPty = unsupportedAsync('redrawPty');
  cth.killPty = unsupportedAsync('killPty');
  cth.listPtys = async () => [];
  cth.resolveSessionCwd = async () => null;

  cth.onPtyData = (id, cb) => {
    if (typeof cb !== 'function') {
      warn('onPtyData requires a callback');
      return () => {};
    }
    const channelId = id != null ? String(id) : '';
    if (!channelId) {
      warn('onPtyData requires a pty id');
      return () => {};
    }
    return subscribeChannel(`pty:data:${channelId}`, (chunk) => cb(chunk));
  };

  cth.onPtyExit = (id, cb) => {
    if (typeof cb !== 'function') {
      warn('onPtyExit requires a callback');
      return () => {};
    }
    const channelId = id != null ? String(id) : '';
    if (!channelId) {
      warn('onPtyExit requires a pty id');
      return () => {};
    }
    return subscribeChannel(`pty:exit:${channelId}`, (info) => cb(info));
  };

  cth.onPtyRelaunch = (id, cb) => {
    if (typeof cb !== 'function') {
      warn('onPtyRelaunch requires a callback');
      return () => {};
    }
    const channelId = id != null ? String(id) : '';
    if (!channelId) {
      warn('onPtyRelaunch requires a pty id');
      return () => {};
    }
    return subscribeChannel(`pty:relaunch:${channelId}`, () => cb());
  };

  window.cth = cth;
  window.__browserBridge = {
    reconnect: connect,
    isConnected: () => connected,
    pending: () => pendingRequests.size,
    subscriptions: () => Array.from(subscriptions.keys())
  };
})();
