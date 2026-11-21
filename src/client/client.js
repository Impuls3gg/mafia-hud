/* ================= ОБЩЕЕ ================= */
const route = location.pathname.replace(/\/$/, '');
const BASE = location.origin + route.replace(/\/(panel|hud|win-civilians|win-mafia)$/, '');
const MODE = route.endsWith('/panel') ? 'panel'
  : route.endsWith('/win-civilians') ? 'red'
  : route.endsWith('/win-mafia') ? 'black'
  : location.hash === '#wait' ? 'wait' : 'overlay';
const screenRoom = /^[a-f0-9]{32}$/.test(location.hash.slice(1))
  ? location.hash.slice(1) : new URLSearchParams(location.search).get('room');
const IC={
  shot:'<svg viewBox="0 0 24 24" class="ic-shot"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>',
  hat:'<svg viewBox="0 0 24 24" class="ic-hat"><path d="M6 16c0-3.6.7-7.3 2.3-9.1.8-.9 2-.7 2.7 0 .5.5 1.5.5 2 0 .7-.7 1.9-.9 2.7 0C17.3 8.7 18 12.4 18 16c-1.8.6-3.8.9-6 .9s-4.2-.3-6-.9z"/><path d="M2 16.2c2.6 1.5 6 2.3 10 2.3s7.4-.8 10-2.3c-.4 2.1-4.6 3.8-10 3.8S2.4 18.3 2 16.2z"/><path class="hb" d="M6.2 13.6c1.8.6 3.7.9 5.8.9s4-.3 5.8-.9v1.6c-1.8.6-3.7.9-5.8.9s-4-.3-5.8-.9z"/></svg>',
  star:'<svg viewBox="0 0 24 24" class="ic-star"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7z"/></svg>',
  hand:'<svg viewBox="0 0 24 24"><path d="M8 12V5.5a1.5 1.5 0 013 0V11m0-6.5V3.5a1.5 1.5 0 013 0V11m0-6a1.5 1.5 0 013 0v6.5m0-3a1.5 1.5 0 013 0V15a7 7 0 01-7 7h-1.5a7 7 0 01-5.3-2.4l-2.7-3.1a1.6 1.6 0 012.3-2.2L8 15.5"/></svg>',
  cross:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>',
  card:'<svg viewBox="0 0 24 24"><rect x="7.5" y="4" width="9" height="14" rx="1.6" fill="#c8102e" transform="rotate(10 12 11)"/></svg>'
};
/* значки ролей: шериф — звезда, дон — шляпа, мафия — револьвер */
// белый силуэт револьвера по референсу: контур тот же, внутри только выемки барабана и спусковая скоба
const REVOLVER_IMG='data:image/png;base64,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';
const BADGE={
  sheriff:'<svg viewBox="0 0 24 24" class="rb-star"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7z"/></svg>',
  don:'<svg viewBox="0 0 24 24" class="rb-hat"><path fill="#fff" d="M6 16c0-3.6.7-7.3 2.3-9.1.8-.9 2-.7 2.7 0 .5.5 1.5.5 2 0 .7-.7 1.9-.9 2.7 0C17.3 8.7 18 12.4 18 16c-1.8.6-3.8.9-6 .9s-4.2-.3-6-.9z"/><path fill="#fff" d="M2 16.2c2.6 1.5 6 2.3 10 2.3s7.4-.8 10-2.3c-.4 2.1-4.6 3.8-10 3.8S2.4 18.3 2 16.2z"/><path class="hb" d="M6.2 13.6c1.8.6 3.7.9 5.8.9s4-.3 5.8-.9v1.6c-1.8.6-3.7.9-5.8.9s-4-.3-5.8-.9z"/></svg>',
  mafia:`<img class="rb-rev" src="${REVOLVER_IMG}" alt="">`
};
const ROLE_PLATE_MS=4000;
const UI_FIELDS=[
  ['th','Высота плашек игроков',120,400,2,'px'],
  ['ts','Размер подписей на плашках',.6,1.8,.05,'×'],
  ['gap','Промежуток между плашками',0,40,1,'px'],
  ['mb','Отступ плашек от низа',0,200,1,'px'],
  ['side','Отступ плашек от краёв',0,200,1,'px'],
  ['ns','Размер таблицы ночей',.5,1.6,.05,'×'],
  ['is','Размер плашки с названием',.5,1.6,.05,'×'],
  ['ot','Прозрачность выбывших игроков',0,100,5,'%']
];
const ACCENTS=['#c41e3a','#e8590c','#f2c230','#2f9e44','#1c7ed6','#8977fe','#d6336c','#e8e8e8'];
function applyAccent(c){
  c=okColor(c)?c:ACCENT_DEF;
  const r=parseInt(c.slice(1,3),16),g=parseInt(c.slice(3,5),16),b=parseInt(c.slice(5,7),16),st=document.documentElement.style;
  st.setProperty('--accent',c);st.setProperty('--accent-glow',`rgba(${r},${g},${b},.22)`);
}
const SIL='<svg viewBox="0 0 100 120" aria-hidden="true"><circle cx="50" cy="42" r="22"/><path d="M8 120c0-30 19-50 42-50s42 20 42 50z"/></svg>';
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const gameText=v=>v.game?'Игра '+v.game:'';

/* ---- Рассадка из MafiaUniverse ----
   На сайте рассадка видна только после входа, а вход закрыт капчей. Поэтому её читает закладка «Отправить в HUD»
   прямо со страницы «Игры» турнира, открытой у судьи, и передаёт в пульт через postMessage. */
const MU_ORIGINS=['https://mafiauniverse.org','https://mafiaworld.org'];
// Выполняется и в закладке на сайте MafiaUniverse, поэтому ничего не берёт снаружи.
function muParse(doc,url){
  const txt=e=>(e&&e.textContent||'').replace(/\s+/g,' ').trim();
  const games=[...doc.querySelectorAll('.box_game_res')].map(b=>{
    const a=b.querySelector('a[href*="/Games/Details/"]'),t=b.querySelector('table');
    if(!a||!t)return null;
    const info=[...b.children].filter(x=>x.tagName==='DIV').map(txt),seats=[];
    t.querySelectorAll('tr').forEach(r=>{const c=r.querySelectorAll('td'),n=parseInt(txt(c[0]),10);if(n>=1&&n<=10)seats[n-1]=txt(c[1])});
    return {key:a.getAttribute('href').split('/').pop(),title:txt(a),judge:info[1]||'',date:info[2]||'',ended:t.classList.contains('ended_true'),seats:Array.from({length:10},(_,i)=>seats[i]||'')};
  }).filter(Boolean);
  const id=(String(url||'').match(/\/(\d+)\/?(?:[?#].*)?$/)||[])[1]||'';
  return {id,url:String(url||''),title:String(doc.title||'').replace(/\s*-\s*MafiaUniverse\s*$/i,'').replace(/^Результаты игр\s*/i,''),games};
}
// Закладку генерирует пульт: в неё зашит только адрес этого сервера.
function muBookmarklet(panelUrl){
  const code=`(()=>{const P=${JSON.stringify(panelUrl)},H=new URL(P).origin;${muParse.toString()}
const d=muParse(document,location.href);
if(!d.games.length){alert('Рассадка не найдена. Откройте на MafiaUniverse раздел «Игры» турнира и нажмите закладку ещё раз.');return}
const w=window.open(P,'mafiahud-panel');if(!w){alert('Браузер не дал открыть пульт HUD. Разрешите всплывающие окна для этого сайта.');return}
let ok=0,n=0;addEventListener('message',e=>{if(e.origin===H&&e.data&&e.data.app==='mafiahud-mu-ack')ok=1});
const t=setInterval(()=>{if(ok){clearInterval(t);return}if(++n>240){clearInterval(t);alert('Пульт HUD не ответил. Войдите в пульт и нажмите закладку ещё раз.');return}try{w.postMessage({app:'mafiahud-mu',data:d},H)}catch(e){}},500)})()`;
  return 'javascript:'+encodeURIComponent(code);
}
/* ---- Экспорт на MafiaUniverse: закладка на странице протокола игры забирает игру из пульта и заполняет форму.
   Сохраняет судья сам, кнопкой на сайте. Допы и штрафы закладка не трогает: их ставят на сайте. ---- */
// Выполняется в закладке на сайте MafiaUniverse, поэтому ничего не берёт снаружи. dry — только проверить, ничего не меняя.
function muFill(doc,d,dry){
  const warn=[],jq=doc.defaultView&&doc.defaultView.jQuery;
  const fire=el=>{if(jq)jq(el).trigger('change');else el.dispatchEvent(new Event('change',{bubbles:true}))};
  const norm=v=>String(v||'').replace(/\s+/g,' ').trim().toLowerCase();
  const rows={};
  doc.querySelectorAll('input[name$=".Position"]').forEach(p=>{const m=p.name.match(/^GamePlayers\[(\d+)\]\.Position$/);if(m)rows[+p.value]=m[1]});
  if(!Object.keys(rows).length)return {ok:false,warn:['На странице нет протокола игры.']};
  const field=(k,name)=>doc.getElementById('GamePlayers_'+k+'__'+name);
  const ROLE={'':'1',civ:'1',sheriff:'2',mafia:'3',don:'4'};
  d.seats.forEach(s=>{
    const k=rows[s.n];if(k==null){warn.push('На сайте нет места '+s.n);return}
    const name=field(k,'Position').closest('tr').querySelector('.GamePlayers_Player_Name');
    if(name&&s.nick&&norm(name.value)!==norm(s.nick))warn.push('Место '+s.n+': на сайте «'+name.value+'», в HUD «'+s.nick+'»');
  });
  if(dry)return {ok:true,warn};
  const roles=d.seats.map(s=>[field(rows[s.n],'GameRoleId'),ROLE[s.role]||'1']).filter(([el])=>el);
  // сайт сам следит, чтобы шериф был один, а мафии не больше двух, поэтому сначала все мирные, потом роли
  roles.forEach(([el])=>{if(el.value!=='1'){el.value='1';fire(el)}});
  roles.forEach(([el,v])=>{if(v!=='1'){el.value=v;fire(el)}});
  d.seats.forEach(s=>{
    const k=rows[s.n];if(k==null)return;
    const tr=field(k,'Position').closest('tr'),foul=field(k,'Foul'),v=Math.min(5,Math.max(0,s.fouls|0));
    if(foul){foul.value=v;const sp=tr.querySelector('.hasfoul');if(sp)sp.textContent=v?v:''}
    const pu=String(s.n-1)===String(d.pu),kf=field(k,'KilledFirst'),bm=field(k,'BestMove');
    if(kf)kf.value=pu?'True':'False';
    if(bm){bm.value=pu?d.lh.map(x=>+x+1).join(','):'';bm.style.display=pu?'':'none'}
  });
  // баллы переносятся, только если судья ставил их в HUD, иначе не затираются поставленные на сайте
  if(d.seats.some(x=>x.b||x.p||x.t))d.seats.forEach(x=>{
    const k=rows[x.n];if(k==null)return;
    [['b','BonusScore'],['p','PenaltyScore'],['t','TechPenaltyScore']].forEach(([key,name])=>{const el=field(k,name);if(el){el.value=(+x[key]||0).toFixed(2).replace('.',',');fire(el)}});
  });
  const win=doc.getElementById('GameWinnerId');
  if(win&&d.winner){win.value=String(d.winner);fire(win)}
  const note=doc.getElementById('Note');
  if(note&&d.note){const cur=note.value.trim();note.value=!cur?d.note:cur.includes(d.note)?cur:cur+'\n\n'+d.note;fire(note)}
  return {ok:true,warn};
}
function muFillBookmarklet(panelUrl){
  const code=`(()=>{const P=${JSON.stringify(panelUrl)},H=new URL(P).origin;${muFill.toString()}
if(!document.querySelector('input[name$=".Position"]')){alert('Откройте на MafiaUniverse протокол игры (редактирование игры) и нажмите закладку ещё раз.');return}
const w=window.open(P,'mafiahud-panel');if(!w){alert('Браузер не дал открыть пульт HUD. Разрешите всплывающие окна для этого сайта.');return}
let done=0,n=0;
addEventListener('message',e=>{
  if(done||e.origin!==H||!e.data||e.data.app!=='mafiahud-mu-export')return;done=1;
  const d=e.data.data,gid=(location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)||[''])[0].toLowerCase();
  const warn=[];if(d.game&&gid&&d.game.toLowerCase()!==gid)warn.push('В HUD сейчас рассажена другая игра MafiaUniverse.');
  warn.push(...muFill(document,d,true).warn);
  if(warn.length&&!confirm(warn.join('\\n')+'\\n\\nВсё равно заполнить протокол?'))return;
  muFill(document,d,false);
  alert('Протокол заполнен из HUD: роли, фолы, первый убиенный и лучший ход'+(d.seats.some(x=>x.b||x.p||x.t)?', допы и минусы':'')+(d.winner?', победа':'')+(d.note?', заметка с голосованиями':'')+'. Проверьте и нажмите «Сохранить».');
});
const t=setInterval(()=>{if(done){clearInterval(t);return}if(++n>480){clearInterval(t);alert('Пульт HUD не ответил. Войдите в пульт и нажмите закладку ещё раз.');return}try{w.postMessage({app:'mafiahud-mu-get'},H)}catch(e){}},500)})()`;
  return 'javascript:'+encodeURIComponent(code);
}
// Данные пришли с чужого сайта, поэтому из них берутся только строки нужной длины.
function muClean(d){
  if(!d||!Array.isArray(d.games)||!d.games.length||d.games.length>500)return null;
  const str=(v,n)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);
  const games=d.games.map(g=>{
    if(!g||!Array.isArray(g.seats))return null;
    const title=str(g.title,80),m=title.match(/^(.*?)\s*стол\s*(\d+)\s*$/i),round=m?m[1]:title;
    const seats=Array.from({length:10},(_,i)=>str(g.seats[i],40));
    return {key:str(g.key,64),title,round,table:m?+m[2]:1,
      judge:str(g.judge,60),date:str(g.date,30),ended:!!g.ended,ready:seats.some(Boolean),seats}; // финал часто заводят до того, как известна рассадка
  }).filter(g=>g&&g.key);
  if(!games.length)return null;
  const url=str(d.url,300);
  return {id:str(d.id,12).replace(/\D/g,''),title:str(d.title,120),url:MU_ORIGINS.some(o=>url.startsWith(o+'/'))?url:'',games};
}
let muInbox=null,muTake=null,muExport=null; // рассадка из закладки ждёт, пока пульт откроется и войдёт; muExport появляется, когда пульт открыт
addEventListener('message',e=>{
  if(!MU_ORIGINS.includes(e.origin)||!e.data)return;
  // закладка «Заполнить протокол» спрашивает игру; пока пульт ждёт пароль, ответа нет, и закладка повторяет запрос
  if(e.data.app==='mafiahud-mu-get'){if(muExport)try{e.source.postMessage({app:'mafiahud-mu-export',data:muExport()},e.origin)}catch{}return}
  if(e.data.app!=='mafiahud-mu')return;
  try{e.source.postMessage({app:'mafiahud-mu-ack'},e.origin)}catch{}
  const d=muClean(e.data.data);if(!d)return;
  if(muTake)muTake(d);else muInbox=d;
});

// Пульт и экраны используют одно соединение с сервером HUD.
const Net = (() => {
  const messages = [];
  const statuses = [];
  const opened = [];
  let socket;
  let retry;
  let status = 'connecting';
  let ready = false;
  let session = null;
  let sessionUntil = 0;

  function setStatus(value) {
    status = value;
    statuses.forEach(listener => listener(value));
  }

  function open(params) {
    clearTimeout(retry);
    ready = false;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
    setStatus('connecting');
    const endpoint = BASE.replace(/^http/, 'ws') + '/ws?' + new URLSearchParams({ role: params.role });
    const useSession = params.role === 'host' && session && Date.now() < sessionUntil;
    socket = new WebSocket(endpoint);
    socket.onopen = () => {
      const auth = useSession ? { session } : { key: params.key, room: params.room };
      socket.send(JSON.stringify({ kind: 'auth', ...auth }));
    };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message?.app !== 'mafiahud') return;
        if (message.kind === 'ready') {
          session = message.session;
          sessionUntil = Date.now() + (message.sessionMs || 0) - 5000;
          ready = true;
          setStatus('ok');
          opened.forEach(listener => listener());
        } else if (ready) messages.forEach(listener => listener(message));
      } catch (error) {
        console.error('Не удалось обработать сообщение HUD:', error);
      }
    };
    socket.onclose = event => {
      ready = false;
      if (event.code === 4408 || (event.code === 4401 && useSession)) {
        session = null;
        open(params);
      } else if (event.code === 4401 || event.code === 4429) {
        setStatus(event.code === 4401 ? 'badkey' : 'limited');
      } else {
        setStatus('off');
        retry = setTimeout(() => open(params), 2000);
      }
    };
  }

  const online = () => ready && socket?.readyState === WebSocket.OPEN;
  return {
    connect(params) {
      session = null;
      open(params);
    },
    online,
    send(message) {
      if (online()) socket.send(JSON.stringify(message));
    },
    get status() { return status; },
    on: listener => messages.push(listener),
    onStatus: listener => statuses.push(listener),
    onOpen: listener => opened.push(listener)
  };
})();
