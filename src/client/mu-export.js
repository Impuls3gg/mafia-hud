const MU_ORIGINS=['https://mafiauniverse.org','https://mafiaworld.org'];

// Запускается как часть закладки на странице редактирования игры.
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
    if(name&&norm(name.value)&&s.nick&&norm(name.value)!==norm(s.nick))warn.push('Место '+s.n+': на сайте «'+name.value+'», в HUD «'+s.nick+'»');
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

async function resolveMuPlayers(doc,seats){
  const norm=nick=>nick.trim().replace(/\s+/g,' ').toLowerCase();
  const validId=value=>/^[1-9]\d*$/.test(String(value));
  const byPlace=new Map(), known=new Map();
  for(const position of doc.querySelectorAll('input[name$=".Position"]')){
    const row=position.closest('tr');
    const name=row?.querySelector('.GamePlayers_Player_Name');
    if(!name)continue;
    const adjacent=name.nextElementSibling;
    const input=row.querySelector('input[type="hidden"][name$=".PlayerId"],input[type="hidden"][name$=".Player.Id"]')
      ||(adjacent?.matches('input[type="hidden"]')&&adjacent!==position?adjacent:null);
    byPlace.set(+position.value,{name,input});
    if(input&&name.value.trim()&&validId(input.value)){
      const nick=norm(name.value);
      if(!known.has(nick))known.set(nick,new Map());
      known.get(nick).set(input.value,{id:input.value,nick:name.value.trim()});
    }
  }
  const search=new Map();
  const slots=seats.map(seat=>{
    const field=byPlace.get(seat.n), nick=norm(seat.nick);
    const existing=known.get(nick);
    if(field?.input&&!existing?.size)search.set(nick,seat.nick);
    return {...field,seat,nick,previousName:field?.name.value,previousId:field?.input?.value};
  });
  const found=new Map();
  async function lookup([key,nick]){
    const form=new URLSearchParams({term:nick});
    for(const [name,id] of [['tournamentId','TournamentIdForFilter'],['withJudges','WithJudges']]){
      const value=doc.getElementById(id)?.value;
      if(value)form.set(name,value);
    }
    try{
      const response=await fetch('/Players/Search/',{
        method:'POST',headers:{'X-Requested-With':'XMLHttpRequest'},body:form,signal:AbortSignal.timeout(8000)
      });
      if(!response.ok)throw new Error();
      const matches=new Map((await response.json()).filter(player=>typeof player?.label==='string'&&norm(player.label)===key&&validId(player.id))
        .map(player=>[String(player.id),{id:String(player.id),nick:player.label}]));
      found.set(key,matches);
    }catch{
      found.set(key,null);
    }
  }
  const queries=[...search];
  await Promise.all(Array.from({length:Math.min(4,queries.length)},async(_,index)=>{
    for(let i=index;i<queries.length;i+=4)await lookup(queries[i]);
  }));
  const exported=new Set(seats.map(seat=>seat.n));
  const used=new Set([...byPlace]
    .filter(([place,field])=>!exported.has(place)&&validId(field.input?.value))
    .map(([,field])=>field.input.value));
  const assignments=[], issues=[];
  for(const {seat,nick,name,input,previousName,previousId} of slots){
    const label='Место '+seat.n+' · '+seat.nick;
    if(!input){issues.push(label+' — в форме нет поля игрока');continue}
    if(name.value!==previousName||input.value!==previousId){issues.push(label+' — состав в MU изменился во время поиска');continue}
    const matches=known.get(nick)??found.get(nick);
    if(!matches){issues.push(label+' — не удалось выполнить поиск в MU');continue}
    if(matches.size!==1){issues.push(label+(matches.size?' — несколько точных совпадений':' — точное совпадение не найдено'));continue}
    const player=matches.values().next().value;
    if(used.has(player.id)){issues.push(label+' — игрок уже указан на другом месте');continue}
    used.add(player.id);
    assignments.push({name,input,player,label});
  }
  // Игрок, оставшийся на пропущенном месте, не может одновременно занять другое.
  const assignedInputs=new Set(assignments.map(({input})=>input));
  const retained=new Set([...byPlace.values()].flatMap(({input})=>
    input&&!assignedInputs.has(input)&&validId(input.value)?[input.value]:[]));
  for(;;){
    const conflict=assignments.findIndex(({input,player})=>input.value!==player.id&&retained.has(player.id));
    if(conflict===-1)break;
    const [{input,label}]=assignments.splice(conflict,1);
    if(validId(input.value))retained.add(input.value);
    issues.push(label+' — игрок остался на другом месте');
  }
  return {assignments,issues};
}

async function applyMuProtocol(d){
  const protocol={...d,seats:d.seats.filter(seat=>seat.nick)};
  if(!protocol.seats.length){alert('В протоколе нет игроков для переноса.');return}
  const preview=muFill(document,protocol,true);
  if(!preview.ok){alert('Откройте редактирование игры на MafiaUniverse.');return}
  const gid=(location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)||[''])[0].toLowerCase();
  if(d.game&&gid&&d.game.toLowerCase()!==gid)preview.warn.unshift('В HUD выбрана другая игра MafiaUniverse.');
  if(preview.warn.length&&!confirm(preview.warn.join('\n')+'\n\nВсё равно заполнить протокол?'))return;
  const {assignments,issues}=await resolveMuPlayers(document,protocol.seats);
  for(const {name,input,player} of assignments){
    name.value=player.nick;
    input.value=player.id;
  }
  muFill(document,protocol,false);
  const skipped=issues.length?'\n\nПропущенные ники:\n'+issues.join('\n'):'';
  alert('Протокол заполнен. Проверьте поля и нажмите «Сохранить».'+skipped);
}

function muSnapshotBookmarklet(protocol){
  const code=`(()=>{
    if(!${JSON.stringify(MU_ORIGINS)}.includes(location.origin)){alert('Откройте игру на MafiaUniverse.');return}
    ${muFill.toString()}
    ${resolveMuPlayers.toString()}
    ${applyMuProtocol.toString()}
    return applyMuProtocol(${JSON.stringify(protocol)});
  })()`;
  return 'javascript:'+encodeURIComponent(code);
}
