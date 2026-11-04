import { motion } from 'framer-motion'
import { EMOTIONS, EMOTION_LIST, LIGHT_THEMES } from '../lib/emotions.js'

const LOG_TYPE_COLORS = {
  系统: '#8e8cf0',
  情绪: '#30d158',
  快捷: '#ffd60a',
  输入: '#5ac8fa',
  调试: '#ff9f0a',
  异常: '#ff453a',
}

export default function DebugPanel({
  emotion,
  logs,
  themeOverride,
  stageStatus,
  typing,
  onClose,
  onForceEmotion,
  onForceTheme,
  onSystemBubble,
}) {
  const emo = EMOTIONS[emotion]

  return (
    <>
      <motion.div
        className="panel-mask"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.aside
        className="debug-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 210, damping: 28 }}
      >
        <header className="panel-header">
          <div>
            <h2>状态监控 · 调试台</h2>
            <p>运行状态 {stageStatus === 'ready' ? '正常' : stageStatus === 'error' ? '异常' : '加载中'} · {typing ? '正在回应' : '待机'}</p>
          </div>
          <button className="btn-close" onClick={onClose} aria-label="关闭">×</button>
        </header>

        {/* 当前状态码 */}
        <section className="panel-section">
          <h3>当前情绪状态</h3>
          <div className="state-card" style={{ '--card-accent': emo.accent }}>
            <motion.span
              key={emo.code}
              className="state-code"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            >
              {emo.code}
            </motion.span>
            <span className="state-label">{emo.label}</span>
          </div>
        </section>

        {/* 手动调试 */}
        <section className="panel-section">
          <h3>手动调试</h3>
          <p className="panel-hint">强制切换角色动作状态</p>
          <div className="chip-grid">
            {EMOTION_LIST.map((key) => (
              <button
                key={key}
                className={`chip ${emotion === key ? 'chip-active' : ''}`}
                onClick={() => onForceEmotion(key)}
              >
                {EMOTIONS[key].label}
              </button>
            ))}
          </div>
          <p className="panel-hint">场景灯光主题色</p>
          <div className="chip-grid">
            {Object.entries(LIGHT_THEMES).map(([key, item]) => (
              <button
                key={key}
                className={`chip ${themeOverride === key ? 'chip-active' : ''}`}
                onClick={() => onForceTheme(key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="btn-glass btn-bubble" onClick={onSystemBubble}>
            发送系统提示气泡
          </button>
        </section>

        {/* 互动历史日志 */}
        <section className="panel-section panel-logs">
          <h3>互动历史日志</h3>
          <div className="log-list">
            {logs.length === 0 && <p className="log-empty">暂无记录</p>}
            {logs.map((log) => (
              <div key={log.id} className="log-item">
                <span className="log-time">{log.time}</span>
                <span className="log-type" style={{ color: LOG_TYPE_COLORS[log.type] || '#98989d' }}>
                  {log.type}
                </span>
                <span className="log-text">{log.text}</span>
              </div>
            ))}
          </div>
        </section>
      </motion.aside>
    </>
  )
}
