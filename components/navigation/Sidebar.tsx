'use client';
import { BookOpen, CalendarDays, Clock3, LayoutDashboard, PhoneCall, Settings } from 'lucide-react';
const items=[['Overview',LayoutDashboard],['Live Calls',PhoneCall],['Reservations',CalendarDays],['Knowledge',BookOpen],['Call History',Clock3],['Settings',Settings]] as const;
export function Sidebar({activeTab,setActiveTab}:{activeTab:string;setActiveTab:(tab:string)=>void}){return <nav>{items.map(([label,Icon])=><button key={label} onClick={()=>setActiveTab(label.toLowerCase().replace(' ','-'))}><Icon size={16}/>{label}{activeTab===label.toLowerCase()&&' •'}</button>)}</nav>}
