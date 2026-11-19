/* ================= ПРАВИЛА ИГРЫ =================
   Этот блок выполняют и пульт, и сервер судьи (src/server/game.js), поэтому к странице он не обращается. */
const ROLES={civ:{t:'Мирный',team:'red'},sheriff:{t:'Шериф',team:'red'},mafia:{t:'Мафия',team:'black'},don:{t:'Дон',team:'black'}};
const UI_DEF={th:236,ts:1,gap:12,mb:30,side:40,ns:1,is:1,ot:55};
const ACCENT_DEF='#c41e3a';
const SCENES=['game','red','black','gameres','standings']; // что показывает худ: игру, победу команды, итоги игры или таблицу турнира
const RES_PAGE=12; // строк итоговой таблицы на одном экране
const okColor=c=>/^#[0-9a-f]{6}$/i.test(c||'');
const newId=()=>'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
function emptySeat(pid){return {pid:pid||'',role:'',status:'alive',fouls:0,bonus:0,pen:0,tech:0}}
// баллы игрока как в протоколе MafiaUniverse: допы (+), минусы (−) и тех. минусы, от 0 до 1,5 с точностью до сотых
const SCORE_FIELDS={b:'bonus',p:'pen',t:'tech'},SCORE_MAX=1.5;
const scoreOf=v=>{const n=Math.round((+v||0)*100)/100;return n>0&&n<=SCORE_MAX?n:0};
function removePlayer(state,id){
  state.roster=state.roster.filter(player=>player.id!==id);
  for(const seat of state.seats)if(seat.pid===id)seat.pid='';
}
function defaultState(){
  const roster=Array.from({length:10},(_,i)=>({id:newId()+i,nick:'Игрок '+(i+1)}));
  return {v:0,revision:0,title:'',roster,seats:roster.map(r=>emptySeat(r.id)),nights:[{shot:'',check:'',don:''}],ui:Object.assign({},UI_DEF),accent:ACCENT_DEF,game:1,mu:null,photoVer:0,showFouls:true,scene:'game',judge:{room:'',hud:''},wait:{show:false,running:false,endAt:0,left:600000,total:600000},
    ...protocolDefaults()};
}
/* ---- протокол дня, как на MafiaUniverse: выставления и голоса по дням, таймер речи, лучший ход, заметки ---- */
const SPEECH_MS=60000;
const EXTRA_SPEECH_MS=30000;
const WINNERS=['','red','black','draw']; // победа, которую ставит судья, как поле «Победитель» на MafiaUniverse
function protocolDefaults(){return {days:[{noms:[]}],timer:{running:false,endAt:0,left:SPEECH_MS,total:SPEECH_MS,speaker:''},lh:['','',''],lhPu:'',lhExtra:null,notes:'',winner:''}}
// в играх, сохранённых до появления протокола, этих полей нет
function protocol(){
  const d=protocolDefaults();
  if(!Array.isArray(S.days)||!S.days.length)S.days=d.days;
  if(!S.timer||typeof S.timer!=='object')S.timer=d.timer;
  if(!Array.isArray(S.lh)||S.lh.length!==3)S.lh=d.lh;
  if(typeof S.notes!=='string')S.notes='';
  if(typeof S.lhPu!=='string')S.lhPu='';
  if(!WINNERS.includes(S.winner))S.winner='';
}
const days=()=>Array.isArray(S.days)&&S.days.length?S.days:protocolDefaults().days;
const curDay=()=>days()[days().length-1];
/* этапы голосования дня: vote — основное, revote — переголосование между набравшими поровну,
   lift — вопрос «поднять всех?», done — итог записан (out — кто покинул стол) */
const stageOf=d=>['vote','revote','lift','done'].includes(d.stage)?d.stage:'vote';
// кандидаты текущего этапа: их плашки на худе приподняты
function ballot(d){const st=stageOf(d);return st==='vote'?d.noms:st==='revote'?(d.revote||[]):st==='lift'?(d.tied||[]).map(i=>({i,v:''})):[]}
const dayMsg=d=>({noms:d.noms.map(n=>({i:n.i,v:n.v})),stage:stageOf(d),revote:(d.revote||[]).map(n=>({i:n.i,v:n.v})),tied:[...(d.tied||[])],out:[...(d.out||[])]});
const timerOf=()=>S.timer&&typeof S.timer==='object'?S.timer:protocolDefaults().timer;
function timerLeft(now=Date.now()){const t=timerOf();return t.running?Math.max(0,t.endAt-now):Math.max(0,+t.left||0)}
function finishSpeech(timer){return {...timer,running:false,speaker:'',endAt:0,left:0}}
// первый убиенный: тот, у кого судья записал лучший ход, а пока не записал — отстрел первой ночи
const firstKilled=()=>(typeof S.lhPu==='string'&&S.lhPu)||(S.nights[0]&&S.nights[0].shot)||'';
const okSeat=v=>v===''||(/^\d+$/.test(v)&&!!S.seats[+v]);
// таймер для экранов: сколько осталось на момент отправки, дальше экран считает сам
function timerView(){
  const t=timerOf(),remain=timerLeft();
  return {running:remain>0&&!!t.running,remain,total:+t.total||SPEECH_MS,speaker:remain>0?t.speaker||'':''};
}
function normalState(s){return {...defaultState(),...s,ui:{...UI_DEF,...s.ui}}}
function waitLeft(){const w=S.wait;return w.running?Math.max(0,w.endAt-Date.now()):Math.max(0,w.left)}
const person=id=>S.roster.find(r=>r.id===id)||null;
const seatNick=i=>{const p=person(S.seats[i].pid);return p?p.nick:''};
const photoKey=s=>s.pid&&photos[s.pid+'.'+s.role]?s.pid+'.'+s.role:s.pid; // для экранов: фото роли, а если его нет — обычное
function shotNight(i){return S.nights.findIndex(n=>n.shot===String(i))}
function nextNight(){const n=S.nights[S.nights.length-1];if(n.shot||n.check||n.don)S.nights.push({shot:'',check:'',don:''})} // как только в последней ночи появилось действие, готовим следующую
function statusOf(i){const s=S.seats[i];return shotNight(i)>=0?'killed':(s.status==='removed'||(+s.fouls||0)>=4)?'removed':(s.status==='voted'?'voted':'alive')}
function buildView(){
  return {t:Date.now(),title:S.title,game:+S.game||0,
    seats:S.seats.map((s,i)=>({pid:s.pid||'',ph:photoKey(s)||'',hp:!!photos[photoKey(s)],nick:seatNick(i),role:s.role,status:statusOf(i),fouls:+s.fouls||0})),showFouls:S.showFouls!==false,
    nights:S.nights.map(n=>({shot:n.shot||'',check:n.check||'',don:n.don||''})),
    ui:Object.assign({},UI_DEF,S.ui),accent:okColor(S.accent)?S.accent:ACCENT_DEF,
    scene:SCENES.includes(S.scene)?S.scene:'game',
    // итоги с MafiaUniverse уходят на экраны, только пока их показывают
    show:S.scene==='gameres'?((S.show||{}).game||null):S.scene==='standings'?((S.show||{}).results||null):null,showPage:Math.max(0,+S.showPage||0),
    timer:timerView(),day:days().length,noms:ballot(curDay()).map(n=>({i:n.i,v:n.v})),
    lh:{pu:firstKilled(),seats:(Array.isArray(S.lh)?S.lh:['','','']).map(String)},
    lhExtra:S.lhExtra||null,
    wait:{show:!!S.wait.show,running:!!S.wait.running,remain:waitLeft(),sentAt:Date.now()}};
}
function seatedPhotos(){return new Set(S.seats.flatMap(s=>[s.pid,photoKey(s)]).filter(Boolean))} // экранам победы нужно обычное фото, худу — фото роли
function stateMsg(){
  return {kind:'state',title:S.title,game:+S.game||0,seats:S.seats.map((s,i)=>({nick:seatNick(i),role:s.role,st:statusOf(i),kn:shotNight(i)+1,fouls:+s.fouls||0,b:scoreOf(s.bonus),p:scoreOf(s.pen),t:scoreOf(s.tech)})),nights:S.nights.map(n=>({shot:n.shot||'',check:n.check||'',don:n.don||''})),
    days:days().map(dayMsg),timer:timerView(),pu:firstKilled(),lh:(Array.isArray(S.lh)?S.lh:['','','']).map(String),lhExtra:S.lhExtra||null,notes:typeof S.notes==='string'?S.notes:'',winner:WINNERS.includes(S.winner)?S.winner:''};
}
// ночь для кнопки «Убит»: текущая, а если в ней пусто, предыдущая без отстрела (там уже могут быть проверки)
function shotTarget(){
  const ns=S.nights;let k=ns.length-1;
  if(k>0&&!ns[k].shot&&!ns[k].check&&!ns[k].don&&!ns[k-1].shot)k--;
  return k;
}
const J={
  role(c){if(c.v===''||Object.hasOwn(ROLES,c.v))S.seats[c.i].role=c.v},
  foul(c){const s=S.seats[c.i];s.fouls=Math.min(4,Math.max(0,(+s.fouls||0)+(c.d>0?1:-1)))},
  status(c){if(['alive','voted','removed'].includes(c.v)){
    const s=S.seats[c.i];s.status=c.v;if(c.v==='alive'&&(+s.fouls||0)>=4)s.fouls=3;
    const d=curDay();if(d.changed)d.changed=d.changed.filter(i=>i!==String(c.i));
  }},
  shot(c){
    const was=shotNight(c.i);
    if(was>=0){S.nights[was].shot='';return}
    S.nights[shotTarget()].shot=String(c.i);
    nextNight();
  },
  night(c){
    const night=Number.isInteger(c.k)?S.nights[c.k]:null,v=String(c.v);
    if(!night||!['shot','check','don'].includes(c.f)||(v!==''&&!(/^\d+$/.test(v)&&S.seats[+v])))return;
    night[c.f]=v;
    nextNight();
  },
  // выставление на голосование в текущий день: повторное нажатие снимает, порядок выставления сохраняется
  nom(c){
    const d=curDay();if(stageOf(d)!=='vote')return; // после итога состав выставленных не меняется
    const k=d.noms.findIndex(n=>n.i===String(c.i));
    if(k>=0)d.noms.splice(k,1);else d.noms.push({i:String(c.i),v:''});
  },
  // число голосов за кандидата текущего этапа (0–10)
  vote(c){
    const d=curDay(),st=stageOf(d),list=st==='vote'?d.noms:st==='revote'?d.revote:null,v=Number(c.v);
    const n=list&&list.find(x=>x.i===String(c.i));
    if(n&&Number.isInteger(v)&&v>=0&&v<=10)n.v=v;
  },
  // итог этапа: один лидер покидает стол, при равенстве — переголосование, а после него — вопрос «поднять всех?»
  voteEnd(){
    const d=curDay(),st=stageOf(d);if(st!=='vote'&&st!=='revote')return;
    const list=st==='vote'?d.noms:d.revote;if(!list||!list.length)return;
    const max=Math.max(...list.map(n=>+n.v||0)),lead=list.filter(n=>(+n.v||0)===max).map(n=>n.i);
    if(lead.length===1)voteOut(d,lead);
    else if(st==='vote'){d.stage='revote';d.revote=lead.map(i=>({i,v:''}))}
    else{d.stage='lift';d.tied=lead}
  },
  lift(c){const d=curDay();if(stageOf(d)!=='lift')return;if(c.v==='up')voteOut(d,d.tied);else if(c.v==='stay'){d.stage='done';d.out=[];d.changed=[]}},
  // отмена итога: заголосованные этим голосованием возвращаются в игру, голоса основного этапа остаются
  voteReset(){
    const d=curDay();(d.changed||[]).forEach(i=>{const s=S.seats[+i];if(s&&s.status==='voted')s.status='alive'});
    d.stage='vote';d.revote=[];d.tied=[];d.out=[];d.changed=[];
  },
  votes(c){const n=curDay().noms.find(x=>x.i===String(c.i));if(n)n.v=Math.min(10,Math.max(0,(+n.v||0)+(c.d>0?1:-1)))},
  day(){const t=S.timer;S.days.push({noms:[],stage:'vote'});t.running=false;t.speaker='';t.left=t.total},
  timer(c){
    const t=S.timer,now=Date.now();
    if(c.op==='speak'){
      const v=String(c.v??'');
      if(!okSeat(v)||(c.ms!==undefined&&![SPEECH_MS,EXTRA_SPEECH_MS].includes(c.ms)))return;
      t.total=c.ms??t.total;
      t.speaker=v;t.left=t.total;t.running=v!=='';t.endAt=now+t.total;
    }
    else if(c.op==='extra'){
      if(!Number.isInteger(c.i)||t.speaker!==String(c.i)||timerLeft(now)===0)return;
      const s=S.seats[c.i];
      if(!s||s.fouls>=2)return;
      if(t.running)t.endAt+=EXTRA_SPEECH_MS;
      else t.left+=EXTRA_SPEECH_MS;
      s.fouls+=2;
    }
    else if(c.op==='start'){if(!t.running&&timerLeft()>0){t.endAt=now+timerLeft();t.running=true}}
    else if(c.op==='pause'){if(t.running&&timerLeft(now)>0){t.left=timerLeft(now);t.running=false}}
    else if(c.op==='stop'){if(t.running||t.speaker!=='')S.timer=finishSpeech(t)}
    else if(c.op==='reset'){t.running=false;t.left=t.total}
    else if(c.op==='set'&&Number.isInteger(c.ms)&&c.ms>=5000&&c.ms<=600000){t.total=c.ms;t.left=c.ms;t.running=false}
  },
  lh(c){const v=String(c.v??'');if(Number.isInteger(c.k)&&c.k>=0&&c.k<3&&okSeat(v))S.lh[c.k]=v},
  // При экспорте протокола используется основной ЛХ.
  lhset(c){
    if(!Array.isArray(c.v))return;
    const picks=[...new Set(c.v.map(String))].filter(v=>/^[0-9]$/.test(v)&&okSeat(v)).slice(0,3);
    const owner=String(c.i),primary=firstKilled();
    if(S.lhExtra?.pu===owner){
      S.lhExtra=picks.length?{pu:owner,seats:picks}:null;
      return;
    }
    if(primary!==''&&primary!==owner&&S.lh.some(Boolean)){
      if(picks.length&&!S.lhExtra)S.lhExtra={pu:owner,seats:picks};
      return;
    }
    if(!picks.length&&primary!==owner)return;
    if(!picks.length&&S.lhExtra){
      S.lhPu=S.lhExtra.pu;
      S.lh=[0,1,2].map(j=>S.lhExtra.seats[j]||'');
      S.lhExtra=null;
      return;
    }
    S.lhPu=picks.length?owner:'';
    S.lh=[0,1,2].map(j=>picks[j]||'');
  },
  notes(c){S.notes=String(c.v??'').slice(0,2000)},
  winner(c){if(WINNERS.includes(c.v))S.winner=c.v},
  score(c){const v=Number(c.v);if(Object.hasOwn(SCORE_FIELDS,c.f)&&Number.isFinite(v)&&v>=0&&v<=SCORE_MAX)S.seats[c.i][SCORE_FIELDS[c.f]]=scoreOf(v)}
};
const NO_SEAT=new Set(['night','day','timer','lh','notes','voteEnd','lift','voteReset','winner']); // команды, которые не относятся к одному игроку
function voteOut(d,seats){
  d.stage='done';d.out=[...seats];d.changed=seats.filter(i=>S.seats[+i]?.status==='alive');
  d.changed.forEach(i=>{S.seats[+i].status='voted'});
}
// выполняет команду судьи и говорит, надо ли сохранить игру
function judgeCommand(m){
  if(!Object.hasOwn(J,m.a)||(!NO_SEAT.has(m.a)&&!(Number.isInteger(m.i)&&m.i>=0&&m.i<S.seats.length)))return false;
  protocol();
  J[m.a](m);return true;
}
// Пульт отправляет на сервер только изменённые поля, поэтому одновременные правки судьи и пульта не затирают друг друга.
function diffState(a,b,path=[],out=[],owner){
  if(JSON.stringify(a)===JSON.stringify(b))return out;
  if(path.length===2){
    if(path[0]==='roster')owner=a?.id;
    if(path[0]==='seats')owner=a?.pid;
  }
  const same=a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)
    &&(!Array.isArray(a)||a.length===b.length)&&Object.keys(a).every(k=>Object.hasOwn(b,k));
  if(same)new Set([...Object.keys(a),...Object.keys(b)]).forEach(k=>diffState(a[k],b[k],[...path,k],out,owner));
  else out.push([path,b,{value:a,owner}]);
  return out;
}
function applyOps(state,ops){
  const owners={roster:state.roster.map(p=>p.id),seats:state.seats.map(s=>s.pid)};
  for(const [path,value,expected] of ops){
    if(expected?.owner!==undefined&&owners[path[0]][path[1]]!==expected.owner)continue;
    const target=path.slice(0,-1).reduce((node,key)=>node?.[key],state);
    if(target&&typeof target==='object')target[path.at(-1)]=structuredClone(value);
  }
}
