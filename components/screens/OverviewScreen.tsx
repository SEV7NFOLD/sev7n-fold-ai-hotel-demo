'use client';
import { INITIAL_LIVE_CALL, MOCK_RESERVATIONS } from '../../lib/mock-data';
export function OverviewScreen(){return <section><h1>Good morning, Aurelia.</h1><h2>Live call · {INITIAL_LIVE_CALL.callerName}</h2><p>{INITIAL_LIVE_CALL.intent}</p><h2>Recent reservations</h2>{MOCK_RESERVATIONS.map(r=><p key={r.id}>{r.guestName} · {r.roomType} · {r.status}</p>)}</section>}
