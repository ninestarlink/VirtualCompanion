import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Live2DStage from './components/Live2DStage.jsx'
import Background from './components/Background.jsx'
import ChatDock from './components/ChatDock.jsx'
import DebugPanel from './components/DebugPanel.jsx'
import { DEFAULT_APPEARANCE, EMOTIONS, LIGHT_THEMES, PART_FEEDBACK, QUICK_ACTIONS, SYSTEM_BUBBLES } from './lib/emotions.js'

let uid = 1
const now = () => new Date().toTimeString().slice(0, 8)
const SENTENCE_END = /[。！？!?~～…\n]+/g
// TTS 前去掉 emoji/符号（屏幕显示保留可爱表情，但语音里不读"小鱼"之类的符号名）
const stripForTts = (s) =>
  s.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim()

// 点击角色不同部位的反馈
const POKE_ZONE_LABEL = { head: '头部', body: '身体', leg: '脚' }
const POKE_REACTIONS = {
  head: { emotion: 'happy', text: '唔…被摸头了，好舒服～再摸一下？' },
  body: { emotion: 'shy', text: '呀！痒痒的，别挠我啦～' },
  leg: { emotion: 'shy', text: '哈哈…脚底不行，站不稳啦！' },
}

export default function App() {
  const [emotion, setEmotion] = useState('idle')
  const [messages, setMessages] = useState([])
  const [logs, setLogs] = useState([])
  const [themeOverride, setThemeOverride] = useState('auto')
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE)
  const [panelOpen, setPanelOpen] = useState(false)
  // 视线是否跟随鼠标，可通过左上角按钮随时开关
  const [gazeFollow, setGazeFollow] = useState(true)
  // 快捷按钮触发的手势序列（由 Live2DStage 播放并按帧推进）
  const [gesture, setGesture] = useState(null)
  // 情绪专属动作：每次切换情绪带一个新 id，让 Live2DStage 播放一次
  const [emotionAction, setEmotionAction] = useState(null)
  // 待播放的手势：等语音真正开始播放时再触发
  const pendingGestureRef = useRef(null)
  // 聊天栏折叠状态提到 App：展开时舞台要给右侧让位，避免聊天框压住角色
  const [dockCollapsed, setDockCollapsed] = useState(false)
  const [typing, setTyping] = useState(false)
  const [stageStatus, setStageStatus] = useState('loading')
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  // 语音真正开始播放（不是开始请求 TTS）时才触发前倾和口型
  const [voicePlaying, setVoicePlaying] = useState(false)
  const modelRef = useRef(null)
  const audioRef = useRef(null)
  const voiceMutedRef = useRef(false)
  const emotionRef = useRef('idle')
  emotionRef.current = emotion
  const sentenceQueue = useRef([])
  const playingRef = useRef(false)
  // 当前这句语音的结束回调（静音时需要立即叫醒播放循环）
  const pendingSpeechDoneRef = useRef(null)

  const addMessage = useCallback((from, text) => {
    setMessages((prev) => [...prev.slice(-40), { id: uid++, from, text, ts: now() }])
  }, [])

  const addLog = useCallback((type, text) => {
    setLogs((prev) => [{ id: uid++, time: now(), type, text }, ...prev.slice(0, 79)])
  }, [])

  useEffect(() => {
    addLog('系统', '互动会话已建立，等待主人唤醒')
    addMessage('companion', '咕噜……你好呀，我是小汐！点我或者跟我聊聊天吧～')
  }, [addMessage, addLog])

  useEffect(() => {
    window.__voiceState = () => {
      const audio = audioRef.current
      return {
        voicePlaying,
        speaking,
        voiceMuted,
        audio: audio
          ? {
              time: Number(audio.currentTime.toFixed(2)),
              duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(2)) : null,
              paused: audio.paused,
              ended: audio.ended,
            }
          : null,
      }
    }
  }, [voicePlaying, speaking, voiceMuted])

  const activeTheme =
    themeOverride !== 'auto' ? LIGHT_THEMES[themeOverride].theme : EMOTIONS[emotion].theme

  const applyEmotion = useCallback((next, reason) => {
    if (!EMOTIONS[next] || next === emotionRef.current) return
    setEmotion(next)
    // 快捷按钮自带手势，不再叠加情绪动作，避免两个动作互相顶掉
    if (reason !== '快捷互动') setEmotionAction({ id: uid++, key: next })
    addLog('情绪', `${EMOTIONS[next].code} · ${EMOTIONS[next].label}${reason ? `（${reason}）` : ''}`)
  }, [addLog])

  // 播放一句话，Promise 在播放结束时兑现；静音/失败立即兑现
  const speak = useCallback(
    (text) =>
      new Promise((resolve) => {
        const finish = () => resolve()
        if (voiceMutedRef.current || !text) {
          pendingGestureRef.current = null
          finish()
          return
        }

        fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 200), emotion: emotionRef.current }),
        })
          .then(async (r) => {
            if (!r.ok) return null
            const speechStart = Number(r.headers.get('X-Speech-Start') || 0)
            const speechEnd = Number(r.headers.get('X-Speech-End') || 0)
            const blob = await r.blob()
            return { blob, speechStart, speechEnd }
          })
          .then(async (result) => {
            const blob = result?.blob
            if (!blob || !blob.type.startsWith('audio')) {
              pendingGestureRef.current = null
              finish()
              return
            }
            const url = URL.createObjectURL(blob)
            const speechStart = result.speechStart
            const speechEnd = result.speechEnd
            let settled = false
            let started = false
            const done = () => {
              if (settled) return
              settled = true
              pendingSpeechDoneRef.current = null
              setVoicePlaying(false)
              audioRef.current?.pause()
              URL.revokeObjectURL(url)
              finish()
            }
            pendingSpeechDoneRef.current = done

            if (voiceMutedRef.current) {
              done()
              return
            }

            const audio = audioRef.current || (audioRef.current = new Audio())
            // 音频开头也可能有空白；等真正到第一个字再开口型、前倾并播放手势
            const beginSpeech = () => {
              if (settled || started) return
              started = true
              setVoicePlaying(true)
              const pending = pendingGestureRef.current
              if (pending) {
                pendingGestureRef.current = null
                setGesture(pending)
              }
            }
            audio.onended = done
            audio.onerror = done
            audio.onplaying = () => {
              if (speechStart <= 0.05) beginSpeech()
            }
            audio.onpause = () => {
              if (!audio.ended) done()
            }
            // 开头按第一个字、结尾按最后一个字收口，跳过 Edge 音频前后的空白
            audio.ontimeupdate = () => {
              if (settled) return
              if (!started && audio.currentTime >= speechStart) beginSpeech()
              const total = Number.isFinite(audio.duration) ? audio.duration : 0
              const endAt = speechEnd > 0 ? speechEnd : total - 0.25
              if (endAt > 0 && audio.currentTime >= endAt) done()
            }
            audio.src = url
            await audio.play().catch(done)
          })
          .catch(() => finish())
      }),
    [],
  )

  // 语音播放循环：句子队列先进先出，边生成边播
  const playNext = useCallback(async () => {
    if (playingRef.current) return
    playingRef.current = true
    setSpeaking(true)
    try {
      while (sentenceQueue.current.length > 0) {
        if (voiceMutedRef.current) break
        const sentence = sentenceQueue.current.shift()
        await speak(sentence)
      }
    } finally {
      playingRef.current = false
      setSpeaking(false)
    }
  }, [speak])

  // 静音开关：同步翻转 ref，清空待播队列，停掉当前朗读
  const toggleVoice = useCallback(() => {
    const next = !voiceMutedRef.current
    voiceMutedRef.current = next
    setVoiceMuted(next)
    sentenceQueue.current = []
    pendingSpeechDoneRef.current?.()
    if (next && audioRef.current) {
      audioRef.current.pause()
    }
    addLog('调试', next ? '已关闭语音朗读' : '已开启语音朗读')
  }, [addLog])

  const send = useCallback(
    async (message, quickAction = null) => {
      const text = message.trim()
      if (!text || typing) return
      addMessage('user', text)
      addLog(quickAction ? '快捷' : '输入', text)
      setTyping(true)

      // 快捷互动附带动作反馈：表情在点击瞬间强制切换，后续回复不再覆盖
      const action = QUICK_ACTIONS.find((q) => q.label === quickAction)
      const forcedEmotion = action?.emotion || null
      if (forcedEmotion) {
        applyEmotion(forcedEmotion, '快捷互动')
      }
      if (action?.gesture) {
        // 先记下手势，等语音真正播放时再触发，避免回复还没开口就做动作
        pendingGestureRef.current = { id: ++uid, steps: action.gesture }
      }

      const streamId = ++uid
      let full = ''
      let ttsConsumed = 0

      // 打字机：增量更新气泡文字
      const updateStreamText = (t) =>
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === streamId)
          if (i < 0) return [...prev, { id: streamId, from: 'companion', text: t, ts: now() }]
          const copy = [...prev]
          copy[i] = { ...copy[i], text: t }
          return copy
        })

      // 把已完成的句子推进语音队列（不等全文生成完）
      const enqueueCompletedSentences = (isFinal) => {
        const rest = full.slice(ttsConsumed)
        if (!rest) return
        const ends = [...rest.matchAll(SENTENCE_END)]
        if (ends.length > 0) {
          const last = ends[ends.length - 1]
          sentenceQueue.current.push(stripForTts(rest.slice(0, last.index + last[0].length)))
          ttsConsumed += last.index + last[0].length
        } else if (isFinal) {
          sentenceQueue.current.push(stripForTts(rest))
          ttsConsumed = full.length
        }
      }

      try {
        const history = messages.slice(-6).map((m) => ({
          role: m.from === 'user' ? 'user' : 'assistant',
          content: m.text,
        }))
        const resp = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history, quick_action: quickAction }),
        })
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`)

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            let event = ''
            let data = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (!event || !data) continue
            const obj = JSON.parse(data)
            if (event === 'emotion') {
              if (!forcedEmotion) applyEmotion(obj.emotion, '对话语义')
            } else if (event === 'delta') {
              full += obj.text
              updateStreamText(full)
              enqueueCompletedSentences(false)
            } else if (event === 'done') {
              enqueueCompletedSentences(true)
            }
          }
        }
        if (full) {
          enqueueCompletedSentences(true)
          addLog('情绪', `回复完成，共 ${full.length} 字（流式）`)
        } else {
          addMessage('companion', '呜……我的网络小气泡破了，再试一次好不好？')
        }
      } catch (err) {
        addMessage('companion', '呜……我的网络小气泡破了，再试一次好不好？')
        addLog('异常', `对话请求失败：${String(err?.message || err)}`)
      } finally {
        setTyping(false)
        playNext()
      }
    },
    [addMessage, addLog, applyEmotion, playNext, messages, typing],
  )

  // 强制切换情绪（调试台）
  const forceEmotion = useCallback(
    (emo) => {
      emotionRef.current = '__force__' // 允许重复点击同一情绪也触发
      setEmotion(emo)
      // 交给 Live2DStage 播放该情绪专属动作（重复点击也会重新触发）
      setEmotionAction({ id: uid++, key: emo })
      addLog('调试', `强制切换动作状态 → ${EMOTIONS[emo].code}`)
    },
    [addLog],
  )

  // 强制切换灯光主题（调试台）
  const forceTheme = useCallback(
    (key) => {
      setThemeOverride(key)
      addLog('调试', `切换场景灯光主题 → ${LIGHT_THEMES[key].label}`)
    },
    [addLog],
  )

  // 发送系统提示气泡（调试台）
  const pushSystemBubble = useCallback(() => {
    const text = SYSTEM_BUBBLES[Math.floor(Math.random() * SYSTEM_BUBBLES.length)]
    addMessage('system', text)
    addLog('调试', '向主画面发送系统提示气泡')
  }, [addMessage, addLog])

  // 点击模型部位换装：裙子 / 内衣 / 鞋子各自独立开关，换完让角色说一句
  const togglePart = useCallback(
    (part) => {
      const info = PART_FEEDBACK[part]
      if (!info) return
      let next
      if (part === 'skirt') next = appearance.skirt === 'short' ? 'long' : 'short'
      else if (part === 'chest') next = appearance.bra === 'on' ? 'off' : 'on'
      else next = appearance.shoes === 'off' ? 'on' : 'off'

      setAppearance((prev) => {
        if (part === 'skirt') return { ...prev, skirt: next }
        if (part === 'chest') return { ...prev, bra: next }
        return { ...prev, shoes: next }
      })

      emotionRef.current = '__force__'
      setEmotion(info.emotion)
      const line = info.lines[next]
      addMessage('companion', line)
      addLog('互动', `点击${info.label} → ${info.values[next]}`)
      // 替换待播队列，连续换装时只保留最新一句
      sentenceQueue.current = [line]
      playNext()
    },
    [appearance, addMessage, addLog, playNext],
  )

  const handleModelReady = useCallback((model) => {
    modelRef.current = model
    try { model.expression(EMOTIONS[emotionRef.current].expression) } catch (_) { /* 忽略 */ }
  }, [])

  // 点击角色不同部位 → 不同反应（抄自参考项目的部位互动玩法）
  const handlePoke = useCallback(
    (zone) => {
      const reaction = POKE_REACTIONS[zone] || POKE_REACTIONS.body
      emotionRef.current = '__force__'
      setEmotion(reaction.emotion)
      addMessage('companion', reaction.text)
      addLog('互动', `点击${POKE_ZONE_LABEL[zone] || '角色'} → ${EMOTIONS[reaction.emotion].code}`)
      // 替换待播队列而不是追加，连点不同部位时只保留最新一句
      sentenceQueue.current = [reaction.text]
      playNext()
    },
    [addMessage, addLog, playNext],
  )

  return (
    <div className="app" style={{ '--accent': activeTheme.accent }}>
      <Background theme={activeTheme} />

      <motion.button
        className={`gaze-toggle ${gazeFollow ? 'is-on' : ''}`}
        onClick={() => {
          const next = !gazeFollow
          setGazeFollow(next)
          addLog('调试', next ? '视线跟随已开启' : '视线跟随已关闭')
        }}
        whileTap={{ scale: 0.92 }}
        aria-pressed={gazeFollow}
        aria-label={gazeFollow ? '关闭视线跟随' : '开启视线跟随'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
          {!gazeFollow && <path d="M3 3l18 18" />}
        </svg>
        <span>{gazeFollow ? '视线跟随' : '视线固定'}</span>
      </motion.button>

      <Live2DStage
        emotion={emotion}
        expression={EMOTIONS[emotion].expression}
        appearance={appearance}
        voicePlaying={voicePlaying}
        gazeFollow={gazeFollow}
        gesture={gesture}
        emotionAction={emotionAction}
        dockOpen={!dockCollapsed}
        onModelReady={handleModelReady}
        onStatus={setStageStatus}
        onPoke={handlePoke}
        onTogglePart={togglePart}
      />

      {/* 顶部状态胶囊 */}
      <motion.header
        className="status-capsule"
        initial={{ y: -60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 120, damping: 16 }}
      >
        <span className="status-dot" />
        <span className="status-name">小汐</span>
        <span className="status-divider" />
        <span className="status-emotion">{EMOTIONS[emotion].label}</span>
        <span className="status-code">{EMOTIONS[emotion].code}</span>
      </motion.header>

      {/* 调试台入口 */}
      <motion.button
        className={`fab-debug ${panelOpen ? 'is-open' : ''}`}
        onClick={() => setPanelOpen((v) => !v)}
        whileTap={{ scale: 0.9 }}
        aria-label="打开调试面板"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
        <span>调试</span>
      </motion.button>

      {/* 聊天 dock */}
      <ChatDock
        messages={messages}
        typing={typing}
        speaking={speaking}
        voiceMuted={voiceMuted}
        collapsed={dockCollapsed}
        onToggleCollapse={() => setDockCollapsed((v) => !v)}
        onToggleVoice={toggleVoice}
        onSend={send}
      />

      {/* 调试台 */}
      <AnimatePresence>
        {panelOpen && (
          <DebugPanel
            emotion={emotion}
            logs={logs}
            themeOverride={themeOverride}
            stageStatus={stageStatus}
            typing={typing}
            onClose={() => setPanelOpen(false)}
            onForceEmotion={forceEmotion}
            onForceTheme={forceTheme}
            onSystemBubble={pushSystemBubble}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
