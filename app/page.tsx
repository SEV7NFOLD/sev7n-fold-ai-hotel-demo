'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, AudioLines, BookOpen, CalendarDays, Check, ChevronRight, Clock3, Headphones, LayoutDashboard, LifeBuoy, Menu, Mic, MicOff, Moon, MoreHorizontal, Phone, PhoneOff, Settings, ShieldCheck, Sparkles, Sun, Volume2, VolumeX, X } from 'lucide-react';
import { SplineScene } from '../components/spline/SplineScene';
import { useGeminiLive } from '../components/voice/useGeminiLive';
import { MOCK_CALL_HISTORY, MOCK_KNOWLEDGE, MOCK_RESERVATIONS } from '../lib/mock-data';

type Screen = 'overview' | 'calls' | 'reservations' | 'knowledge' | 'history' | 'settings';
const navItems: { id: Screen; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'calls', label: 'Live Calls', icon: Phone },
  { id: 'reservations', label: 'Reservations', icon: CalendarDays }, { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'history', label: 'Call History', icon: Clock3 }, { id: 'settings', label: 'Settings', icon: Settings },
];
const formatNaira = (amount: number) => `₦${amount.toLocaleString('en-NG')}`;

function Welcome({ onEnter }: { onEnter: () => void }) {
  return <motion.div className="welcome" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 1.03 }} transition={{ duration: .7 }}>
    <div className="welcome-grain"/><div className="welcome-glow glow-one"/><div className="welcome-glow glow-two"/>
    <motion.div className="welcome-content" initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: .25, duration: .8 }}>
      <span className="welcome-seal">A</span><p className="welcome-brand">SEV7N FOLD <i>AI</i></p><div className="welcome-hotel">THE AURELIA HOTEL <span>·</span> LAGOS</div>
      <h1>A warmer welcome<br/>starts with <em>Ava.</em></h1><p className="welcome-copy">Your hotel, always within reach.</p>
      <div className="welcome-orbit"><i/><i/><i/><div className="welcome-orb">A</div></div>
      <button className="enter-button" onClick={onEnter}>Enter your experience <ChevronRight size={16}/></button>
      <button className="skip-button" onClick={onEnter}>SKIP INTRO</button>
    </motion.div><span className="welcome-foot">AN INTELLIGENT GUEST EXPERIENCE</span>
  </motion.div>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={'brand ' + (compact ? 'compact' : '')}><span className="brand-seal">A</span><span><b>SEV7N FOLD <i>AI</i></b><small>THE AURELIA HOTEL · LAGOS</small></span></div>;
}

function Navigation({ active, onSelect, onClose }: { active: Screen; onSelect: (screen: Screen) => void; onClose?: () => void }) {
  return <nav className="nav-list">{navItems.map(({ id, label, icon: Icon }) => <button className={active === id ? 'nav-item active' : 'nav-item'} key={id} onClick={() => { onSelect(id); onClose?.(); }}><Icon size={17}/><span>{label}</span>{id === 'calls' && <i className="nav-live">DEMO</i>}</button>)}</nav>;
}

function Header({ dark, onTheme, onMenu }: { dark: boolean; onTheme: () => void; onMenu: () => void }) {
  return <header className="topbar"><button className="menu-button" aria-label="Open navigation" onClick={onMenu}><Menu size={20}/></button><Brand compact/><div className="topbar-right"><span className="online-pill"><i/> AVA IS HERE</span><button className="theme-button" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onTheme}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</button><button className="avatar" aria-label="Guest profile">G</button></div></header>;
}

function VoiceWave({ small = false }: { small?: boolean }) { return <div className={small ? 'wave small-wave' : 'wave'} aria-label="Voice waveform">{Array.from({ length: small ? 25 : 39 }, (_, i) => <i key={i} style={{ '--h': `${18 + ((i * 19 + i * i * 7) % 76)}%` } as React.CSSProperties}/>)}</div>; }

function ChatHome({ onCalls, onReservations }: { onCalls: () => void; onReservations: () => void }) {
  return <div className="chat-page"><div className="hello-line"><span>THURSDAY · OCTOBER 02</span><span className="secure"><ShieldCheck size={13}/> PRIVATE & SECURE</span></div>
    <div className="chat-welcome"><p>Good morning,</p><h1>How can I make<br/>your stay <em>special?</em></h1><div className="welcome-spark">✳</div></div>
    <div className="prompt-chips"><button onClick={onReservations}><CalendarDays size={14}/> View my reservation</button><button onClick={onCalls}><Headphones size={14}/> Start call</button></div>
    <section className="message-card guest-request"><div className="message-meta"><span className="tiny-avatar guest-avatar">G</span><b>Your request</b><time>Just now</time></div><p>Ideas to make my stay at The Aurelia unforgettable</p></section>
    <section className="message-card assistant-card"><div className="message-meta"><span className="ava-avatar">A</span><b>Ava <small>· HOTEL CONCIERGE</small></b><button aria-label="More options"><MoreHorizontal size={18}/></button></div>
      <p className="assistant-lead">Of course. I’d love to help make your time with us feel exceptional.</p>
      <div className="audio-card"><button className="play-audio" aria-label="Play sample voice message"><AudioLines size={18}/></button><VoiceWave small/><span>00:18</span></div>
      <p>We can arrange a private airport pickup, reserve a table at The Sunken Lounge, or prepare your room with a little something special. What sounds lovely?</p>
      <div className="suggestion-row"><button onClick={onCalls}>Airport pickup <ChevronRight size={13}/></button><button onClick={onCalls}>Dining <ChevronRight size={13}/></button></div>
      <div className="message-footer"><span><Check size={12}/> Tailored to The Aurelia</span><span>AVA · NOW</span></div>
    </section>
    <div className="conversation-note"><Sparkles size={13}/> Thoughtful help, whenever you need it.</div>
    <Composer onSend={onCalls}/>
  </div>;
}

function Composer({ onSend }: { onSend: () => void }) {
  return <div className="composer"><div className="composer-tools"><span>245 credits remaining</span><button>Upgrade</button></div><textarea aria-label="Message Ava" placeholder="Ask anything about your stay…" rows={2}/><div className="composer-bottom"><button className="mic-button" aria-label="Voice demo" onClick={onSend}><Mic size={16}/><span>Speak with Ava</span></button><button className="send-button" aria-label="Send message" onClick={onSend}><ArrowUp size={17}/></button></div></div>;
}

function CallsScreen({ onEnd, dark, onTheme }: { onEnd: () => void; dark: boolean; onTheme: () => void }) {
  const live=useGeminiLive();
  const state=live.status;
  const statusText=live.muted?'MICROPHONE MUTED':state==='ERROR'?'CONNECTION ISSUE':state==='CONNECTING'?'CONNECTING':state;
  return <main className={'call-experience call-'+state.toLowerCase()}><SplineScene/><div className="call-vignette" aria-hidden="true"/>
    <header className="call-topbar"><button className="call-back" aria-label="Exit call" onClick={onEnd}><X size={20}/></button><span className="call-title">THE AURELIA <i>·</i> AVA</span><button className="theme-button" aria-label="Toggle appearance" onClick={onTheme}>{dark?<Sun size={17}/>:<Moon size={17}/>}</button></header>
    <div className="call-center" aria-live="polite"><div className="call-presence"><i/> {statusText}</div><p className="call-live-caption">{live.message}</p>{live.error&&<p className="call-error-message">{live.error}</p>}</div>
    <div className="call-dock"><VoiceWave/><div className="dock-controls"><button className={live.muted?'dock-control toggled':'dock-control'} aria-label={live.muted?'Unmute microphone':'Mute microphone'} aria-pressed={live.muted} onClick={live.toggleMute}>{live.muted?<MicOff size={18}/>:<Mic size={18}/>}</button><button className="hangup-button" aria-label="End call" onClick={onEnd}><PhoneOff size={19}/></button><button className={live.speakerEnabled?'dock-control':'dock-control toggled'} aria-label={live.speakerEnabled?'Mute speaker':'Unmute speaker'} aria-pressed={!live.speakerEnabled} onClick={live.toggleSpeaker}>{live.speakerEnabled?<Volume2 size={18}/>:<VolumeX size={18}/>}</button></div><span className="demo-label">{state==='ERROR'?'VOICE UNAVAILABLE':state==='CONNECTING'?'CONNECTING TO GEMINI':'LIVE WITH AVA · '+state}</span></div>
  </main>;
}

function ReservationsScreen() { return <section className="screen-content"><ScreenTitle eyebrow="YOUR STAY" title="Reservations" sub="The details, all in one place."/>{MOCK_RESERVATIONS.map(r=><article className="list-card" key={r.id}><div className="list-card-top"><span className="room-tag">{r.roomType}</span><span className={r.status==='Confirmed'?'state-tag confirmed':'state-tag pending'}>{r.status}</span></div><h2>{r.guestName}</h2><p>{r.checkIn} — {r.checkOut} · {r.guestsCount} guests</p><div className="list-card-bottom"><small>{r.id}</small><b>{formatNaira(r.totalAmountNaira)}</b></div></article>)}</section>; }
function KnowledgeScreen() { return <section className="screen-content"><ScreenTitle eyebrow="A LITTLE LOCAL KNOWLEDGE" title="The Aurelia guide" sub="Draft case-study details and sample prices. Confirm with the hotel before client launch."/>{MOCK_KNOWLEDGE.map(k=><article className="guide-card" key={k.id}><span>{k.category.toUpperCase()} · {k.lastUpdated.toUpperCase()}</span><h2>{k.title}</h2><p>{k.content}</p></article>)}</section>; }
function HistoryScreen() { return <section className="screen-content"><ScreenTitle eyebrow="RECENT CONVERSATIONS" title="Call history" sub="Your recent conversations with the hotel."/>{MOCK_CALL_HISTORY.map(c=><article className="history-card" key={c.id}><span className="history-icon"><Phone size={16}/></span><div><b>{c.callerName}</b><p>{c.intent}</p><small>{c.timestamp} · {c.duration}</small></div><span className="history-status">{c.humanEscalated?'Team follow-up':'Resolved'}</span></article>)}</section>; }
function SettingsScreen({ dark, onTheme }: { dark: boolean; onTheme: () => void }) { return <section className="screen-content"><ScreenTitle eyebrow="MAKE YOURSELF AT HOME" title="Settings" sub="Shape your Aurelia experience."/><div className="settings-group"><p>APPEARANCE</p><button className="setting-row" onClick={onTheme}><span className="setting-icon">{dark?<Moon size={17}/>:<Sun size={17}/>}</span><span><b>{dark?'Dark':'Light'} theme</b><small>Switch to {dark?'light':'dark'} appearance</small></span><span className={'toggle '+(dark?'on':'')}/></button><p>YOUR EXPERIENCE</p><button className="setting-row"><span className="setting-icon"><LifeBuoy size={17}/></span><span><b>Contact the front desk</b><small>We’re here around the clock</small></span><ChevronRight size={17}/></button><button className="setting-row"><span className="setting-icon"><ShieldCheck size={17}/></span><span><b>Privacy & preferences</b><small>Your comfort and privacy matter</small></span><ChevronRight size={17}/></button></div></section>; }
function ScreenTitle({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) { return <div className="screen-title"><span>{eyebrow}</span><h1>{title}</h1><p>{sub}</p></div>; }

export default function Page() {
  const [screen,setScreen]=useState<Screen>('overview'); const [dark,setDark]=useState(false); const [intro,setIntro]=useState(true); const [menu,setMenu]=useState(false); const [callOpen,setCallOpen]=useState(false);
  useEffect(()=>{const timer=window.setTimeout(()=>setIntro(false),2800);return()=>window.clearTimeout(timer)},[]);
  useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light'},[dark]);
  const go=(target:Screen)=>{setMenu(false);if(target==='calls'){setCallOpen(true);return}setScreen(target)};
  if(callOpen) return <CallsScreen onEnd={()=>setCallOpen(false)} dark={dark} onTheme={()=>setDark(!dark)}/>;
  return <main className="app-shell"><AnimatePresence>{intro&&<Welcome onEnter={()=>setIntro(false)}/>}</AnimatePresence>
    <aside className="desktop-sidebar"><Brand/><div className="side-caption">YOUR AURELIA EXPERIENCE</div><Navigation active={screen} onSelect={go}/><div className="side-bottom"><span className="online-pill"><i/> AVA IS HERE</span><p>Thoughtful hospitality,<br/>powered by SEV7N FOLD AI.</p></div></aside>
    <div className="app-main"><Header dark={dark} onTheme={()=>setDark(!dark)} onMenu={()=>setMenu(true)}/><div className="screen-wrap" key={screen}><AnimatePresence mode="wait" initial={false}><motion.div key={screen} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-5}} transition={{duration:.2}}>{screen==='overview'?<ChatHome onCalls={()=>go('calls')} onReservations={()=>go('reservations')}/>:screen==='calls'?null:screen==='reservations'?<ReservationsScreen/>:screen==='knowledge'?<KnowledgeScreen/>:screen==='history'?<HistoryScreen/>:<SettingsScreen dark={dark} onTheme={()=>setDark(!dark)}/>}</motion.div></AnimatePresence></div><footer className="app-footer">© 2026 SEV7N FOLD AI <span>THE AURELIA HOTEL · LAGOS</span></footer></div>
    <nav className="mobile-nav" aria-label="Main navigation">{navItems.slice(0,4).map(({id,label,icon:Icon})=><button className={screen===id?'active':''} key={id} onClick={()=>go(id)}><Icon size={18}/><span>{label==='Overview'?'Home':label==='Reservations'?'Stay':label==='Knowledge'?'Guide':'Ava'}</span></button>)}<button className={screen==='history'||screen==='settings'?'active':''} onClick={()=>setMenu(true)}><MoreHorizontal size={19}/><span>More</span></button></nav>
    <AnimatePresence>{menu&&<><motion.button className="scrim" aria-label="Close navigation" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={()=>setMenu(false)}/><motion.aside className="mobile-sheet" initial={{y:'100%'}} animate={{y:0}} exit={{y:'100%'}} transition={{type:'spring',damping:28,stiffness:250}}><div className="sheet-handle"/><div className="sheet-heading"><Brand compact/><button onClick={()=>setMenu(false)} aria-label="Close"><X size={18}/></button></div><Navigation active={screen} onSelect={go}/><button className="sheet-theme" onClick={()=>setDark(!dark)}>{dark?<Sun size={17}/>:<Moon size={17}/>} Switch to {dark?'light':'dark'} theme</button></motion.aside></>}</AnimatePresence>
  </main>;
}
