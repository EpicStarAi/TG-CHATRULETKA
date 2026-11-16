import { useEffect, useRef, useState } from 'react';
import { T, LANGS } from './i18n.js';

const API = import.meta.env.VITE_API_URL || '';
const WS_BASE = (API || window.location.origin).replace(/^http/, 'ws');

export default function App() {
  const [lang, setLang] = useState(localStorage.getItem('lang') || 'en');
  const [ageOk, setAgeOk] = useState(localStorage.getItem('age18') === '1');
  const [token, setToken] = useState(() => localStorage.getItem('token') || '');
  const [status, setStatus] = useState('idle'); // idle | searching | matched
  const [peerName, setPeerName] = useState('');
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  // UI-only redesign state (filters/toggles are visual for now; wired to the backend later).
  const [showSettings, setShowSettings] = useState(false);
  const [gender, setGender] = useState(localStorage.getItem('gender') || 'any');
  const [country, setCountry] = useState(localStorage.getItem('country') || 'any');
  const [translate, setTranslate] = useState(localStorage.getItem('translate') === '1');
  const [safeMode, setSafeMode] = useState(localStorage.getItem('safeMode') === '1');
  const [online, setOnline] = useState(null);
  const facingRef = useRef('user'); // 'user' | 'environment' for camera flip

  const t = T[lang];
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const streamRef = useRef(null);
  const iceRef = useRef(null); // per-match ICE servers (incl. short-lived TURN credentials) from the server

  useEffect(() => { localStorage.setItem('lang', lang); }, [lang]);

  useEffect(() => {
    fetch(`${API}/config`).then((r) => r.json()).then(setConfig).catch(() => setConfig({ iceServers: [] }));
  }, []);

  // Live online counter from /health (real connected count).
  useEffect(() => {
    let alive = true;
    const tick = () => fetch(`${API}/health`).then((r) => r.json())
      .then((d) => { if (alive) setOnline(typeof d.online === 'number' ? d.online : null); })
      .catch(() => {});
    tick();
    const id = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => { localStorage.setItem('gender', gender); }, [gender]);
  useEffect(() => { localStorage.setItem('country', country); }, [country]);
  useEffect(() => { localStorage.setItem('translate', translate ? '1' : '0'); }, [translate]);
  useEffect(() => { localStorage.setItem('safeMode', safeMode ? '1' : '0'); }, [safeMode]);

  // Telegram Mini App sign-in with initData. Runs automatically on open and again from the button.
  const tg = window.Telegram?.WebApp;
  const inTelegram = !!tg && !!tg.platform && tg.platform !== 'unknown';
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  function telegramLogin() {
    const init = tg?.initData;
    if (!init) { setAuthError(inTelegram ? t.errNoInitData : t.errOpenInTelegram); return; }
    setAuthBusy(true); setAuthError('');
    fetch(`${API}/auth/telegram`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: init }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.token) { localStorage.setItem('token', d.token); setToken(d.token); return; }
        setAuthError(d.error === 'expired' ? t.errExpired : `${t.errRejected} (${d.error || r.status})`);
      })
      .catch(() => setAuthError(t.errNetwork))
      .finally(() => setAuthBusy(false));
  }

  useEffect(() => {
    tg?.ready?.();
    tg?.expand?.();
    if (tg?.initData && !token) telegramLogin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function acceptAge() {
    localStorage.setItem('age18', '1');
    setAgeOk(true);
  }

  // Bind the local stream to the self-view <video> and make sure it actually plays.
  function attachLocalPreview() {
    const el = localRef.current;
    const stream = streamRef.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = true; // required for autoplay of a self-view
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch((err) => console.warn('local preview play() blocked:', err?.name, err?.message));
  }

  async function startCamera() {
    // getUserMedia only exists in a secure context (HTTPS or localhost).
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const e = new Error('insecure context'); e.name = 'InsecureContextError'; throw e;
    }
    if (!streamRef.current) {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingRef.current }, audio: true });
      // Log what we actually got so a black preview can be diagnosed (no device / black frame vs. render bug).
      for (const tr of streamRef.current.getTracks()) {
        console.info(`camera track: kind=${tr.kind} label=${tr.label || '(none)'} state=${tr.readyState} enabled=${tr.enabled}`);
      }
      if (!streamRef.current.getVideoTracks().length) console.warn('getUserMedia returned no video track');
    }
    // Always (re)bind + play, even when reusing an existing stream after Stop/Start.
    attachLocalPreview();
    return streamRef.current;
  }

  // Switch between front/back cameras, replacing the outgoing track on the live peer connection.
  async function flipCamera() {
    if (!streamRef.current) return;
    const next = facingRef.current === 'user' ? 'environment' : 'user';
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next }, audio: false });
      const newTrack = ns.getVideoTracks()[0];
      if (!newTrack) throw new Error('no video track');
      const sender = pcRef.current?.getSenders?.().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      const old = streamRef.current.getVideoTracks()[0];
      if (old) { streamRef.current.removeTrack(old); old.stop(); }
      streamRef.current.addTrack(newTrack);
      facingRef.current = next;
      attachLocalPreview();
    } catch (e) { console.warn('flip camera failed:', e?.name, e?.message); }
  }

  function logout() {
    try { wsRef.current?.close(); } catch { /* ignore */ }
    closePeer();
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    localStorage.removeItem('token');
    setToken(''); setStatus('idle'); setShowSettings(false); setMessages([]); setPeerName('');
  }

  // Map a getUserMedia failure to a specific, translated hint (and log the raw error for debugging).
  function cameraErrorText(err) {
    console.error('startCamera failed:', err?.name, err?.message, err);
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return inTelegram ? t.cameraWeb : t.cameraNoPermission;
      case 'NotFoundError':
      case 'OverconstrainedError':
        return t.cameraNotFound;
      case 'NotReadableError':
      case 'AbortError':
        return t.cameraInUse;
      case 'InsecureContextError':
      case 'TypeError':
        return t.cameraInsecure;
      default:
        return t.cameraDenied;
    }
  }

  function closePeer() {
    pcRef.current?.close();
    pcRef.current = null;
    if (remoteRef.current) remoteRef.current.srcObject = null;
  }

  function makePeer(role) {
    closePeer();
    const pc = new RTCPeerConnection({ iceServers: iceRef.current || config?.iceServers || [] });
    pcRef.current = pc;
    streamRef.current?.getTracks().forEach((tr) => pc.addTrack(tr, streamRef.current));
    pc.ontrack = (e) => { if (remoteRef.current) remoteRef.current.srcObject = e.streams[0]; };
    pc.onicecandidate = (e) => { if (e.candidate) wsRef.current?.send(JSON.stringify({ type: 'signal', data: { candidate: e.candidate } })); };
    if (role === 'caller') {
      pc.onnegotiationneeded = async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsRef.current?.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
      };
    }
    return pc;
  }

  async function handleSignal(data) {
    let pc = pcRef.current;
    if (data.sdp) {
      if (!pc) pc = makePeer('callee');
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        wsRef.current?.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
      }
    } else if (data.candidate && pc) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  async function connect() {
    setError('');
    try { await startCamera(); } catch (e) { setError(cameraErrorText(e)); return; }
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => { setStatus('searching'); ws.send(JSON.stringify({ type: 'start' })); };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'auth_required') { setToken(''); localStorage.removeItem('token'); }
      if (msg.type === 'searching') setStatus('searching');
      if (msg.type === 'matched') {
        setStatus('matched'); setPeerName(msg.name); setMessages([]);
        iceRef.current = msg.iceServers || null;
        if (msg.role === 'caller') makePeer('caller');
        else makePeer('callee');
      }
      if (msg.type === 'signal') await handleSignal(msg.data);
      if (msg.type === 'chat') setMessages((m) => [...m, { from: 'them', text: msg.text }]);
      if (msg.type === 'peer_left') { closePeer(); setStatus('searching'); setPeerName(''); ws.send(JSON.stringify({ type: 'start' })); }
    };
    ws.onclose = () => { setStatus('idle'); closePeer(); };
  }

  function sendNext() { closePeer(); wsRef.current?.send(JSON.stringify({ type: 'next' })); setStatus('searching'); setMessages([]); }
  function stop() { wsRef.current?.send(JSON.stringify({ type: 'stop' })); wsRef.current?.close(); closePeer(); setStatus('idle'); }
  function report() { wsRef.current?.send(JSON.stringify({ type: 'report' })); closePeer(); setStatus('searching'); }
  function block() { report(); }

  function sendChat(e) {
    e.preventDefault();
    const v = text.trim();
    if (!v || status !== 'matched') return;
    wsRef.current?.send(JSON.stringify({ type: 'chat', text: v }));
    setMessages((m) => [...m, { from: 'me', text: v }]);
    setText('');
  }

  const LangPicker = (
    <select className="lang" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language">
      {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
    </select>
  );

  if (!ageOk) {
    return (
      <div className="screen gate">
        <header className="brand"><img src="/logo.svg" alt="" /><h1>TG⭐CHATRULETKA</h1>{LangPicker}</header>
        <p className="lead">{t.gateText}</p>
        <button className="btn primary" onClick={acceptAge}>{t.gateYes}</button>
        <p className="fine">{t.gateNo}</p>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="screen login">
        <header className="brand"><img src="/logo.svg" alt="" /><h1>TG⭐CHATRULETKA</h1>{LangPicker}</header>
        <p className="lead">{t.loginText}</p>
        {inTelegram
          ? <button className="btn tg" onClick={telegramLogin} disabled={authBusy}>{authBusy ? t.signingIn : t.loginTelegram}</button>
          : <a className="btn tg" href={`https://t.me/${config?.botUsername || import.meta.env.VITE_BOT_USERNAME || ''}`}>{t.loginTelegram}</a>}
        {authError && <p className="error">{authError}</p>}
        <p className="fine">{t.legal}</p>
      </div>
    );
  }

  const COUNTRIES = [
    { code: 'any', flag: '🌍' }, { code: 'RU', flag: '🇷🇺' }, { code: 'UA', flag: '🇺🇦' },
    { code: 'US', flag: '🇺🇸' }, { code: 'PH', flag: '🇵🇭' }, { code: 'DE', flag: '🇩🇪' },
    { code: 'TR', flag: '🇹🇷' }, { code: 'IN', flag: '🇮🇳' },
  ];
  const curCountry = COUNTRIES.find((c) => c.code === country) || COUNTRIES[0];
  const genderEmoji = { any: '👥', male: '👨', female: '👩' }[gender] || '👥';
  const active = status !== 'idle';

  if (showSettings) {
    return (
      <div className="app settings">
        <header className="sheet-head">
          <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="Back">←</button>
          <h1>{t.settingsTitle}</h1>
        </header>
        <div className="list">
          <label className="row">
            <span className="row-ic">🌐</span>
            <span className="row-main"><span className="row-title">{t.languageLabel}</span></span>
            <select className="row-select" value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t.languageLabel}>
              {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
          <div className="row">
            <span className="row-ic">🔤</span>
            <span className="row-main"><span className="row-title">{t.translateMessages}</span></span>
            <button role="switch" aria-checked={translate} className={`toggle${translate ? ' on' : ''}`} onClick={() => setTranslate((v) => !v)}><span /></button>
          </div>
          <div className="row">
            <span className="row-ic">🛡️</span>
            <span className="row-main"><span className="row-title">{t.safeMode}</span></span>
            <button role="switch" aria-checked={safeMode} className={`toggle${safeMode ? ' on' : ''}`} onClick={() => setSafeMode((v) => !v)}><span /></button>
          </div>
          <a className="row link" href={`${API}/legal/rules`} target="_blank" rel="noreferrer"><span className="row-ic">📋</span><span className="row-main"><span className="row-title">{t.chatRules}</span></span><span className="chev">›</span></a>
          <a className="row link" href={`${API}/legal/agreement`} target="_blank" rel="noreferrer"><span className="row-ic">✅</span><span className="row-main"><span className="row-title">{t.userAgreement}</span></span><span className="chev">›</span></a>
          <a className="row link" href={`${API}/legal/privacy`} target="_blank" rel="noreferrer"><span className="row-ic">🔒</span><span className="row-main"><span className="row-title">{t.privacyPolicy}</span></span><span className="chev">›</span></a>
          <button className="row link" onClick={logout}><span className="row-ic">↩️</span><span className="row-main"><span className="row-title">{t.logout}</span></span></button>
        </div>
        <button className="row danger" onClick={() => { if (window.confirm(t.deleteConfirm)) logout(); }}>
          <span className="row-ic">🗑️</span><span className="row-main"><span className="row-title">{t.deleteProfile}</span></span>
        </button>
      </div>
    );
  }

  return (
    <div className="app chat">
      <section className="stage">
        <button className="gear" onClick={() => setShowSettings(true)} aria-label={t.settingsTitle}>⚙</button>
        <video ref={remoteRef} autoPlay playsInline className="remote" />
        {!active && (
          <div className="hero">
            <img src="/logo.svg" alt="" className="hero-logo" />
            <div className="hero-title">TG⭐CHATRULETKA</div>
            {online != null && <div className="hero-online"><span className="dot" />{online.toLocaleString()} {t.online}</div>}
          </div>
        )}
        {active && status !== 'matched' && <div className="overlay">{t.searching}</div>}
        {peerName && <div className="peer">{peerName}</div>}
        <div className="self-wrap">
          <video ref={localRef} autoPlay playsInline muted className="self" />
          <button className="flip" onClick={flipCamera} aria-label={t.flipCamera}>🔄</button>
        </div>
      </section>

      <section className="panel">
        <div className="filters">
          <button className="pill" onClick={() => setGender((g) => (g === 'any' ? 'male' : g === 'male' ? 'female' : 'any'))} disabled={active}>
            <span className="pill-label">{t.yourGender}</span><span className="pill-val">{genderEmoji}</span>
          </button>
          <label className="pill as-select">
            <span className="pill-label">{t.country}</span><span className="pill-val">{curCountry.flag}</span>
            <select value={country} onChange={(e) => setCountry(e.target.value)} disabled={active} aria-label={t.country}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code === 'any' ? t.genderAny : c.code}</option>)}
            </select>
          </label>
        </div>

        {!active && (
          <div className="rules">
            <span className="rules-ic">📹</span>
            <p>{t.rulesNote}</p>
          </div>
        )}
        {active && (
          <div className="messages">
            {messages.map((m, i) => <div key={i} className={m.from === 'me' ? 'msg me' : 'msg'}>{m.text}</div>)}
          </div>
        )}
        {error && <p className="error">{error}</p>}

        <form className="composer" onSubmit={sendChat}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.typeMessage} maxLength={500} disabled={status !== 'matched'} />
          <button type="submit" className="send" aria-label={t.send} disabled={status !== 'matched'}>➤</button>
        </form>

        <div className="actions">
          <button className="big stop" onClick={stop} disabled={!active}>{t.stop}</button>
          {status === 'matched'
            ? <button className="big start" onClick={sendNext}>{t.next}</button>
            : <button className="big start" onClick={connect} disabled={status === 'searching'}>{t.start}</button>}
        </div>
      </section>
    </div>
  );
}
