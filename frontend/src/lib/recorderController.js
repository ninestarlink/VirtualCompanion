// MediaRecorder 录音控制器：点一次开始，再点一次结束；最长 60 秒自动结束。
// 状态机与错误提示沿用 micController 的思路：所有失败都给出可见原因，不静默退出。
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/wav',
]

export function createRecorder({ onListening, onTip, onAudio, maxMs = 60000 }) {
  let recorder = null
  let stream = null
  let chunks = []
  let active = false
  let timer = null
  let disposed = false

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const stopTracks = () => {
    try { stream?.getTracks().forEach((track) => track.stop()) } catch (_) { /* 忽略 */ }
    stream = null
  }

  const fail = (message) => {
    clearTimer()
    active = false
    stopTracks()
    recorder = null
    onListening(false)
    onTip(message)
  }

  const start = async () => {
    if (active || disposed) return
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      onTip('当前浏览器不支持录音，请用 Chrome 或 Edge')
      return
    }

    // 授权弹窗期间也要有反馈，避免看起来“点了没反应”
    onTip('正在请求麦克风权限…')

    let media
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = err?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        fail('麦克风权限被拒绝：请在地址栏允许麦克风后重试（需要 localhost 或 https）')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        fail('没有检测到麦克风，请检查设备连接后再试')
      } else if (name === 'NotReadableError') {
        fail('麦克风被其他程序占用了，请关闭占用它的应用再试')
      } else {
        fail(`麦克风启动失败（${name || '未知错误'}）`)
      }
      return
    }

    if (disposed) {
      try { media.getTracks().forEach((track) => track.stop()) } catch (_) { /* 忽略 */ }
      return
    }
    stream = media

    const mimeType = PREFERRED_TYPES.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || ''
    try {
      recorder = mimeType
        ? new window.MediaRecorder(media, { mimeType })
        : new window.MediaRecorder(media)
    } catch (_) {
      fail('当前浏览器无法创建录音器，请用 Chrome 或 Edge')
      return
    }

    chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data)
    }
    recorder.onerror = (event) => {
      fail(`录音出错（${event?.error?.name || '未知错误'}）`)
    }
    recorder.onstop = () => {
      clearTimer()
      const type = recorder?.mimeType || mimeType || 'audio/webm'
      const blob = new Blob(chunks, { type })
      chunks = []
      active = false
      stopTracks()
      recorder = null
      onListening(false)
      if (disposed) return
      if (blob.size === 0) {
        onTip('没有录到音频，请再试一次')
        return
      }
      onAudio(blob)
    }

    try {
      recorder.start()
    } catch (_) {
      fail('录音启动失败，请重试')
      return
    }
    active = true
    onListening(true)
    onTip('正在录音，再点一下结束（最长 60 秒）')
    timer = setTimeout(() => { stop() }, maxMs)
  }

  const stop = () => {
    if (!active) return
    clearTimer()
    active = false
    try {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop()
      } else {
        stopTracks()
        recorder = null
        onListening(false)
      }
    } catch (_) {
      fail('停止录音失败，请重试')
      return
    }
    onTip('正在识别…')
  }

  const dispose = () => {
    disposed = true
    clearTimer()
    active = false
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop()
    } catch (_) { /* 忽略 */ }
    stopTracks()
    recorder = null
  }

  return {
    start,
    stop,
    isListening: () => active,
    dispose,
  }
}
