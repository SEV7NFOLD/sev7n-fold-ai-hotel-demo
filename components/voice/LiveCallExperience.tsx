'use client';
import { INITIAL_LIVE_CALL } from '../../lib/mock-data';
export function LiveCallExperience(){return <section><h2>Live call · {INITIAL_LIVE_CALL.callerName}</h2><p>{INITIAL_LIVE_CALL.intent}</p>{INITIAL_LIVE_CALL.transcript.map(m=><p key={m.id}>{m.sender}: {m.text}</p>)}</section>}
