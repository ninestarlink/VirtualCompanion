// 麦克风识别控制器
// 把 Web Speech API 的启停/续听/错误状态机从组件里拆出来：
// 1) 用户点一次开麦，点第二次才关麦；浏览器 onend 只代表「这一段结束」，不代表用户关麦。
// 2) 所有非静音错误都要给出可见提示，不能静默把界面退回关闭状态。
// 3) createRecognition 可注入，方便在不接麦克风的环境里用 mock 事件做确定性验证。
export function createMicController({ createRecognition, onListening, onTip, onText }) {
  let rec = null
  let staying = false // 用户意图：是否仍在听
  let generation = 0 // 代次，隔离旧识别实例的回调
  let fatal = false // 是否遇到不可恢复错误
  let restartTimer = null
  let lastEndAt = 0
  let rapidRestarts = 0

  const clearRestart = () => {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  const notifyListening = (next) => {
    staying = next
    onListening(next)
  }

  // 不可恢复错误：停掉识别器、退出监听、留下可见提示
  const fail = (message) => {
    fatal = true
    clearRestart()
    const current = rec
    rec = null
    try { current?.abort?.() } catch (_) { /* 忽略 */ }
    notifyListening(false)
    onTip(message)
  }

  const start = (baseText = '') => {
    clearRestart()
    fatal = false
    rapidRestarts = 0
    lastEndAt = 0
    const myGeneration = ++generation
    const recognition = createRecognition()
    rec = recognition
    recognition.lang = 'zh-CN'
    // continuous=true：浏览器支持时会一直听，直到用户第二次点击
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    let finals = ''

    recognition.onstart = () => {
      if (myGeneration !== generation) return
      onTip('正在听你说，再点一下麦克风就结束')
    }

    recognition.onresult = (event) => {
      if (myGeneration !== generation || !staying) return
      let interim = ''
      let added = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const text = result[0]?.transcript || ''
        if (result.isFinal) added += text
        else interim += text
      }
      if (added) finals += added
      onText((baseText + finals + interim).slice(0, 200))
    }

    recognition.onerror = (event) => {
      if (myGeneration !== generation) return
      const code = event?.error
      // 用户主动停止/旧实例中止：不算错误
      if (code === 'aborted') return
      // 浏览器只是这一小段没听到人声，不是用户关麦；继续听，onend 会重连
      if (code === 'no-speech') return

      if (code === 'network') {
        fail('语音识别服务连不上（浏览器在线识别失败），请改用 Edge 浏览器，或直接打字。')
      } else if (code === 'audio-capture') {
        fail('没有检测到可用的麦克风，请检查设备连接后再试。')
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        fail('麦克风权限被拒绝了，请在地址栏允许麦克风后再点一次。')
      } else {
        fail(`语音识别出错（${code || '未知错误'}），请重试或直接打字。`)
      }
    }

    recognition.onend = () => {
      if (myGeneration !== generation) return
      if (!staying || fatal) {
        notifyListening(false)
        return
      }
      // 浏览器因静音/超时/不支持 continuous 而主动结束：自动续听，绝不自动关麦
      const now = Date.now()
      rapidRestarts = now - lastEndAt < 1200 ? rapidRestarts + 1 : 0
      lastEndAt = now
      if (rapidRestarts >= 6) {
        fail('语音识别反复中断，可能连不上识别服务，请改用 Edge 或直接打字。')
        return
      }
      clearRestart()
      restartTimer = setTimeout(() => {
        if (myGeneration !== generation || !staying || fatal) return
        try {
          recognition.start()
        } catch (_) {
          if (myGeneration !== generation) return
          fail('语音识别无法继续，请重点一次麦克风。')
        }
      }, 250)
    }

    notifyListening(true)
    onTip('正在连接麦克风…')
    try {
      recognition.start()
    } catch (err) {
      if (myGeneration !== generation) return
      // 实例已经在跑，视为已经开始，不能当成失败把界面关掉
      if (err?.name === 'InvalidStateError') {
        onTip('正在听你说，再点一下麦克风就结束')
        return
      }
      fail('麦克风启动失败，请检查权限或稍后再试。')
    }
  }

  const stop = () => {
    generation += 1 // 让旧实例的 onend/onerror 失效，避免误重连
    staying = false
    fatal = false
    clearRestart()
    const current = rec
    rec = null
    try { current?.stop?.() } catch (_) { /* 忽略 */ }
    onListening(false)
    onTip(null)
  }

  return {
    start,
    stop,
    isListening: () => staying,
  }
}
