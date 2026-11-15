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

  // Telegram Mini App: log in automatically with initData
  useEffect(() => {
    const init = window.Telegram?.WebApp?.initData;
    if (!init || token) return;
    window.Telegram.WebApp.ready();
    fetch(`${API}/auth/telegram`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: init }),
    }).then((r) => r.json()).then((d) => {
      if (d.token) { localStorage.setItem('token', d.token); setToken(d.token); }
    });
  }, [token]);

  function acceptAge() {
    localStorage.setItem('age18', '1');
    setAgeOk(true);
  }

  async function startCamera() {
    if (streamRef.current) return streamRef.current;
    streamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localRef.current) localRef.current.srcObject = streamRef.current;
    return streamRef.current;
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
    try { await startCamera(); } catch { setError(t.cameraDenied); return; }
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
        <a className="btn tg" href={config?.telegramEnabled ? 'https://t.me/' + (import.meta.env.VITE_BOT_USERNAME || '') : '#'}>{t.loginTelegram}</a>
        <p className="fine">{t.legal}</p>
      </div>
    );
  }

  return (
    <div className="screen chat">
      <header className="brand"><img src="/logo.svg" alt="" /><h1>TG⭐CHATRULETKA</h1>{LangPicker}</header>
      <div className="videos">
        <video ref={remoteRef} autoPlay playsInline className="remote" />
        <video ref={localRef} autoPlay playsInline muted className="local" />
        {status !== 'matched' && <div className="overlay">{status === 'searching' ? t.searching : t.readyText}</div>}
        {peerName && <div className="peer">{peerName}</div>}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="messages">
        {messages.map((m, i) => <div key={i} className={m.from === 'me' ? 'msg me' : 'msg'}>{m.text}</div>)}
      </div>
      <form className="chatbar" onSubmit={sendChat}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.typeMessage} maxLength={500} />
        <button type="submit" className="btn send" aria-label={t.send}>➤</button>
      </form>
      <div className="controls">
        {status === 'idle'
          ? <button className="btn primary" onClick={connect}>{t.start}</button>
          : <button className="btn stop" onClick={stop}>{t.stop}</button>}
        <button className="btn next" onClick={sendNext} disabled={status === 'idle'}>{t.next}</button>
        <button className="btn ghost" onClick={report} disabled={status !== 'matched'}>{t.report}</button>
        <button className="btn ghost" onClick={block} disabled={status !== 'matched'}>{t.block}</button>
      </div>
    </div>
  );
}
