// 服务端语音识别客户端：把录音 Blob POST 给后端 /api/asr
// 错误按类型区分，交给界面显示不同提示（权限/上传/服务不可达/被拒绝）
export class AsrError extends Error {
  constructor(kind, message, status = 0) {
    super(message)
    this.name = 'AsrError'
    this.kind = kind // upload | unreachable | rejected | too-large | rate | unconfigured | empty
    this.status = status
  }
}

export async function transcribeAudio(blob, { endpoint = '/api/asr' } = {}) {
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    })
  } catch (_) {
    throw new AsrError('upload', '上传失败：连不上后端服务，请确认服务已启动')
  }

  let data = null
  try { data = await response.json() } catch (_) { /* 非 JSON 响应 */ }

  if (!response.ok) {
    const detail = (data && data.detail) || `HTTP ${response.status}`
    if (response.status === 413) throw new AsrError('too-large', detail, response.status)
    if (response.status === 429) throw new AsrError('rate', detail, response.status)
    if (response.status === 502) throw new AsrError('unreachable', detail, response.status)
    if (response.status === 503) throw new AsrError('unconfigured', detail, response.status)
    throw new AsrError('rejected', detail, response.status)
  }

  const text = String((data && data.text) || '').trim()
  if (!text) throw new AsrError('empty', '没有识别到内容，请靠近麦克风再说一次')
  return text
}
