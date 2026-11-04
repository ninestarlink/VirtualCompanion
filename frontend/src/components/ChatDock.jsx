import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { QUICK_ACTIONS } from '../lib/emotions.js'
import { createMicController } from '../lib/micController.js'
import { createRecorder } from '../lib/recorderController.js'
import { transcribeAudio } from '../lib/asrClient.js'

function BubbleList({ messages, typing, speaking }) {
  const listRef = useRef(null)

  // 新消息、正在输入、正在回答时都滚到底部，避免最新一句藏在上面
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, typing, speaking])

  return (
    <div className="bubble-list" ref={listRef}>
      <AnimatePresence initial={false}>
        {messages.slice(-4).map((m) => (
          <motion.div
            key={m.id}
            className={`bubble bubble-${m.from}`}
            initial={{ opacity: 0, y: 16, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
          >
            {m.from === 'system' && <span className="bubble-tag">系统</span>}
            {m.text}
          </motion.div>
        ))}
        {typing && (
          <motion.div
            key="typing"
            className="bubble bubble-companion bubble-typing"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <span /><span /><span />
          </motion.div>
        )}
        {speaking && !typing && (
          <motion.div
            key="speaking"
            className="bubble bubble-companion bubble-speaking"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <span className="voice-wave">
              <i /><i /><i /><i /><i />
            </span>
            正在回答……
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function ChatDock({ messages, typing, speaking, voiceMuted, collapsed, onToggleCollapse, onToggleVoice, onSend }) {
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [micTip, setMicTip] = useState(null)
  const inputRef = useRef(null)
  const micRef = useRef(null)
  const recorderRef = useRef(null)
  const lastMessage = messages[messages.length - 1]

  useEffect(() => () => {
    recorderRef.current?.dispose()
    micRef.current?.stop()
  }, [])

  // 录音结束后上传后端识别，把文本回填输入框
  const handleAudio = async (blob) => {
    setTranscribing(true)
    setMicTip('正在识别…')
    try {
      const text = await transcribeAudio(blob)
      setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text).slice(0, 200))
      setMicTip('识别完成，可以发送啦')
      setTimeout(() => setMicTip((prev) => (prev === '识别完成，可以发送啦' ? null : prev)), 2200)
    } catch (err) {
      const kind = err?.kind
      if (kind === 'unreachable') setMicTip(`识别服务不可达：${err.message}`)
      else if (kind === 'upload') setMicTip(err.message)
      else if (kind === 'too-large') setMicTip('录音文件太大，请缩短录音后重试')
      else if (kind === 'rate') setMicTip('说话太频繁啦，休息几秒再试')
      else if (kind === 'unconfigured') setMicTip('服务端还没配置语音识别，请联系管理员')
      else if (kind === 'empty') setMicTip(err.message)
      else setMicTip(`识别失败：${err?.message || '未知错误'}`)
    } finally {
      setTranscribing(false)
    }
  }

  const ensureRecorder = () => {
    if (!recorderRef.current) {
      recorderRef.current = createRecorder({
        onListening: setListening,
        onTip: setMicTip,
        onAudio: handleAudio,
      })
    }
    return recorderRef.current
  }

  const ensureMic = () => {
    if (!micRef.current) {
      micRef.current = createMicController({
        createRecognition: () => new (window.SpeechRecognition || window.webkitSpeechRecognition)(),
        onListening: setListening,
        onTip: setMicTip,
        onText: (text) => setInput(text.slice(0, 200)),
      })
    }
    return micRef.current
  }

  // 默认走 MediaRecorder → 服务端识别；浏览器不支持录音时才退回 Web Speech
  const toggleMic = () => {
    if (transcribing) return

    const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
    if (canRecord) {
      const recorder = ensureRecorder()
      if (recorder.isListening()) recorder.stop()
      else recorder.start()
      return
    }

    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Ctor) {
      setMicTip('当前浏览器既不支持录音也不支持语音识别，请用 Chrome 或 Edge')
      return
    }
    const mic = ensureMic()
    if (mic.isListening()) {
      mic.stop()
      inputRef.current?.focus()
      return
    }
    const base = input.trim() ? `${input.trim()} ` : ''
    mic.start(base)
  }

  const submit = (e) => {
    e.preventDefault()
    if (!input.trim() || typing || transcribing) return
    onSend(input)
    setInput('')
    inputRef.current?.focus()
  }

  return (
    <motion.section
      className={`chat-dock ${collapsed ? 'is-collapsed' : ''}`}
      initial={{ y: 120, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 110, damping: 18, delay: 0.15 }}
    >
      {/* 折叠/展开：收起后只留一枚小胶囊，不再挡住角色 */}
      <button
        className="btn-dock-toggle"
        onClick={onToggleCollapse}
        aria-label={collapsed ? '展开聊天栏' : '收起聊天栏'}
        title={collapsed ? '展开聊天栏' : '收起聊天栏'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          {collapsed ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}
        </svg>
      </button>

      {collapsed && (
        <button className="chat-dock-peek" onClick={onToggleCollapse}>
          <span className="peek-dot" />
          {typing ? '小汐正在输入…' : lastMessage ? lastMessage.text.slice(0, 26) : '点这里和小汐聊天'}
        </button>
      )}

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="dock-body"
            className="chat-dock-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
          >
            <BubbleList messages={messages} typing={typing} speaking={speaking} />

            <AnimatePresence>
              {micTip && (
                <motion.div
                  className="mic-tip"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  {micTip}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="quick-row">
              {QUICK_ACTIONS.map((q) => (
                <motion.button
                  key={q.key}
                  className="btn-quick"
                  disabled={typing}
                  whileTap={{ scale: 0.92 }}
                  whileHover={{ y: -2 }}
                  onClick={() => onSend(q.message, q.label)}
                >
                  {q.label}
                </motion.button>
              ))}
              <motion.button
                className={`btn-voice-toggle ${voiceMuted ? 'is-muted' : ''}`}
                onClick={onToggleVoice}
                whileTap={{ scale: 0.9 }}
                aria-label={voiceMuted ? '开启语音朗读' : '关闭语音朗读'}
                title={voiceMuted ? '开启语音朗读' : '关闭语音朗读'}
              >
                {voiceMuted ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5 6 9H2v6h4l5 4z" />
                    <path d="m23 9-6 6M17 9l6 6" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5 6 9H2v6h4l5 4z" />
                    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9.5 9.5 0 0 1 0 14" />
                  </svg>
                )}
              </motion.button>
            </div>

            <form className="chat-form" onSubmit={submit}>
              <motion.button
                type="button"
                className={`btn-mic ${listening ? 'is-listening' : ''}`}
                onClick={toggleMic}
                disabled={typing || transcribing}
                whileTap={{ scale: 0.9 }}
                aria-label={transcribing ? '正在识别语音' : '点击说话'}
                title={transcribing ? '正在识别…' : listening ? '停止录音' : '点击说话'}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
                </svg>
                {listening && <span className="mic-ring" />}
              </motion.button>
              <input
                ref={inputRef}
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={transcribing ? '正在识别语音…' : listening ? '正在录音……再点一下麦克风结束' : '跟小汐说点什么，也可以点麦克风直接讲……'}
                maxLength={200}
                enterKeyHint="send"
              />
              <motion.button
                type="submit"
                className="btn-send"
                disabled={typing || transcribing || !input.trim()}
                whileTap={{ scale: 0.9 }}
                aria-label="发送"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2 11 13" />
                  <path d="M22 2 15 22l-4-9-9-4Z" />
                </svg>
              </motion.button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  )
}
