'use client';
import { MOCK_KNOWLEDGE } from '../../lib/mock-data';
export function KnowledgeScreen(){return <main><h1>Knowledge base</h1>{MOCK_KNOWLEDGE.map(k=><article key={k.id}><h2>{k.title}</h2><p>{k.content}</p></article>)}</main>}
