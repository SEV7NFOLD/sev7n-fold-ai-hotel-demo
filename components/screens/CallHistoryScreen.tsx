'use client';
import { MOCK_CALL_HISTORY } from '../../lib/mock-data';
export function CallHistoryScreen(){return <main><h1>Call history</h1>{MOCK_CALL_HISTORY.map(c=><article key={c.id}>{c.timestamp} · {c.callerName} · {c.status}</article>)}</main>}
