'use client';
import { MOCK_RESERVATIONS } from '../../lib/mock-data';
export function ReservationsScreen(){return <main><h1>Reservations</h1>{MOCK_RESERVATIONS.map(r=><article key={r.id}>{r.guestName} · {r.roomType} · {r.status}</article>)}</main>}
