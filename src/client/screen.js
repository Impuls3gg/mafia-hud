if(MODE!=='panel'){
  let V = null;
  const timerClock=createTimerClock();
  const pc = Object.create(null);
  const photo = id => pc[id] || null;
  const vTeam=i=>ROLES[(V.seats[i]||{}).role||'civ'].team;
  // цвет игрока как у номера на его плашке: шериф и дон — цвет роли, остальные — цвет команды
  const vColor=i=>{const r=(V.seats[i]||{}).role;return r==='sheriff'?'sher':r==='don'?'don':vTeam(i)};
  let draw=()=>{},drawTimerUpdate=()=>{};

  function prune(){
    if(!V||!V.seats)return;
    const keep=new Set(V.seats.flatMap(s=>[s.pid,s.ph]).filter(Boolean));
    for (const id of Object.keys(pc)) if (!keep.has(id)) delete pc[id];
  }
  function applyView(v){
    if (!v?.seats) return;
    V=v;
    if(v.timer)timerClock.update(v.timer);
    prune();draw();
  }
  Net.on(m=>{
    if(m.kind==='view')applyView(m.view);
    else if(m.kind==='timer'&&V){
      V.timer=m.timer;
      if(m.foul)V.seats[m.foul.seat].fouls=m.foul.count;
      timerClock.update(m.timer);
      drawTimerUpdate(m.foul);
    }
    else if (m.kind === 'photo') {
      if (m.data) pc[m.pid] = m.data;
      else delete pc[m.pid];
      draw();
    }
    else if(m.kind==='ping')Net.send({kind:'pong',mode:MODE});
  });
  Net.onOpen(()=>Net.send({kind:'hello',mode:MODE,timerUpdates:true}));

  /* ---------- оверлей ---------- */
  if(MODE==='overlay'){
    document.body.className='overlay';
    document.body.innerHTML=`<div id="stage">
      <div class="dim"></div>
      <div class="info"><div class="in"><div class="t"></div><div class="g"></div></div></div>
      <div class="nights"></div><div class="row"></div>
      <div class="spk"><div class="clk"></div><div class="sw"></div></div>
      <div class="wb"><div class="win red"><span></span></div></div>
      <div class="resb"><div class="rh"></div><div class="rt"></div></div></div>`;
    const stage=document.getElementById('stage'),q=s=>stage.querySelector(s),row=q('.row');
    let scene=null,moveT=null,flipT=null;
    const banner=sc=>{const w=q('.wb .win');w.className='win '+sc;w.firstChild.textContent=sc==='red'?'ПОБЕДА МИРНЫХ':'ПОБЕДА МАФИИ'};
    // переходы включаются только на время смены сцены, чтобы ползунки размеров в пульте работали без задержки
    function setScene(sc){
      if(sc===scene)return;
      const first=scene===null,was=scene;scene=sc;
      const win=sc==='red'||sc==='black',wb=q('.wb'); // экран победы; экраны итогов показываются отдельно (sc-res)
      clearTimeout(moveT);clearTimeout(flipT);wb.classList.remove('flip');
      if(!first){stage.classList.add('moving');moveT=setTimeout(()=>stage.classList.remove('moving'),2200)}
      // с одной победы на другую: надпись схлопывается и раскрывается уже в цвете другой команды
      if(win&&!first&&(was==='red'||was==='black')){wb.classList.add('flip');flipT=setTimeout(()=>{banner(sc);wb.classList.remove('flip')},350)}
      else if(win)banner(sc);
      stage.classList.toggle('sc-win',win);
      stage.classList.toggle('sc-res',sc==='gameres'||sc==='standings');
    }
    // название турнира: в игре в правом верхнем углу, на экране победы над надписью по центру
    function placeScene(u){
      const info=q('.info'),nb=q('.nights'),wb=q('.wb'),win=scene!=='game',res=scene==='gameres'||scene==='standings';
      const iw=info.offsetWidth,ih=info.offsetHeight,bh=q('.wb .win').offsetHeight;
      const k=Math.max(1.3,u.is*1.3),gap=40,titleH=info.style.display==='none'?0:ih*k+gap;
      // на экранах итогов название наверху, под ним таблица; на экране победы — над надписью в середине
      const room=1080-u.mb-u.th-30,top=res?36:Math.max(30,(room-titleH-bh)/2);
      wb.style.top=(top+titleH)+'px';
      q('.resb').style.top=(top+titleH)+'px';
      // точка привязки .info — правый верхний угол (right:40px, top:36px)
      info.style.transform=win?`translate(${960+iw*k/2-1880}px,${top-36}px) scale(${k})`:(u.is===1?'':`scale(${u.is})`);
      nb.style.transform=win?`translate(-130%,-60px) rotate(-12deg) scale(${u.ns})`:(u.ns===1?'':`scale(${u.ns})`);
    }
    const tiles=Array.from({length:10},(_,i)=>{
      const t=document.createElement('div');
      t.innerHTML=`<div class="body"><div class="ph"></div><div class="accent"></div><div class="badge"></div><div class="rp"><span></span></div>
        <div class="bot"><div class="num">${i+1}</div><div class="nick"><span></span></div></div></div><div class="st"></div><div class="fc"></div><div class="lhp"></div>`;
      row.appendChild(t);return t;
    });
    const paintNow=(el,p)=>{el.style.backgroundImage=p?`url("${p}")`:'none';el.innerHTML=p?'':SIL};
    const paint=(el,p)=>{
      if(el._p===p)return;
      const first=el._p===undefined,prev=el._p;el._p=p;
      if(first){paintNow(el,p);return}
      if(el._swap){clearTimeout(el._swap);el._swap=null;paintNow(el,prev)} // прошлая смена ещё идёт: сразу её завершаем
      const id=el._id=(el._id||0)+1;
      const start=()=>{
        if(el._id!==id)return; // пока фото декодировалось, его уже сменили
        const l=document.createElement('div');l.className='swap';
        if(p)l.style.backgroundImage=`url("${p}")`;else{l.style.backgroundColor='#26262c';l.innerHTML=SIL}
        el.appendChild(l);
        // таймер, а не animationend: в скрытом источнике OBS анимация может не дойти до конца
        el._swap=setTimeout(()=>{
          if(p)el.style.backgroundImage=`url("${p}")`; // слой снимаем чуть позже, когда под ним уже новое фото
          el._swap=setTimeout(()=>{el._swap=null;paintNow(el,p)},80);
        },700);
      };
      // слой запускается только с готовой картинкой, иначе виден кадр без фото
      if(p){const im=new Image();im.src=p;im.decode().then(start,start)}else start();
    };
    draw=function(){
      applyAccent(V&&V.accent);
      stage.style.visibility=V?'visible':'hidden';
      // Подсказка, если файл открыли в обычном браузере, а не в OBS
      let hint=document.getElementById('hint');
      if(!V&&!window.obsstudio){
        if(!hint){
          hint=document.createElement('div');hint.id='hint';
          hint.innerHTML=`<div class="hint-box"><h1>Это HUD для OBS</h1>
            <p>Сам по себе HUD прозрачный и показывается только в OBS, поверх камеры. Для трансляции используйте ссылку со страницы «OBS» в пульте.</p>
            <button id="toPanel">Открыть пульт</button></div>`;
          document.body.appendChild(hint);
          document.getElementById('toPanel').onclick=()=>{location.href = BASE + '/panel'};
        }
      }else if(hint)hint.remove();
      if(!V)return;
      const u=Object.assign({},UI_DEF,V.ui||{});
      stage.style.setProperty('--th',u.th+'px');stage.style.setProperty('--ts',u.ts);
      stage.style.setProperty('--gap',u.gap+'px');stage.style.setProperty('--mb',u.mb+'px');stage.style.setProperty('--side',u.side+'px');
      stage.style.setProperty('--out-op',((100-Math.min(100,Math.max(0,+u.ot)))/100).toFixed(2)); // убитые, заголосованные и удалённые
      q('.info .t').textContent=V.title||'';
      const gl=gameText(V);
      q('.info .g').textContent=gl;
      q('.info .g').style.display=gl?'block':'none';
      q('.info').style.display=(V.title||gl)?'flex':'none';
      const sc=SCENES.includes(V.scene)?V.scene:'game';
      setScene(sc);placeScene(u);
      const bestMoves=[V.lh,V.lhExtra];
      tiles.forEach((t,i)=>{
        const s=V.seats[i]||{},role=ROLES[s.role]?s.role:'',st=s.status||'alive';
        // на экране победы игрок без роли считается мирным, как и в проверках; пустые места исчезают вместе с проигравшими
        const res=sc==='game'?'':(sc==='red'||sc==='black')&&s.pid&&ROLES[role||'civ'].team===sc?' winner':' loser'; // на экранах итогов плашки уходят
        // победители показываются целиком, даже если их убили или заголосовали
        const out=st!=='alive'&&res!==' winner';
        const nom=sc==='game'&&st==='alive'&&(V.noms||[]).some(n=>n.i===String(i));
        t.className=`tile team-${role?ROLES[role].team:'norole'} r-${role||'none'} s-${out?st:'alive'}`+(out?' out':'')+res+(nom?' nom':'');
        const picks=bestMoves.find(lh=>lh?.pu===String(i))?.seats?.filter(Boolean)||[];
        const lp=t.querySelector('.lhp'),showLh=sc==='game'&&picks.length>0;
        lp.classList.toggle('on',showLh);
        lp.innerHTML=showLh?'<span class="lb">ЛХ</span>'+picks.map(v=>`<span class="chip ${vColor(+v)}">${+v+1}</span>`).join(''):'';
        // фото ещё в пути (s.hp): оставляем прежнее, с его приходом draw повторится
        const pic=photo(s.ph||s.pid);if(pic||!s.hp)paint(t.querySelector('.ph'),pic);
        const bd=t.querySelector('.badge'),was=bd._r;
        if(was!==role){
          bd._r=role;bd.innerHTML=BADGE[role]||'';
          // при выдаче активной роли её название ненадолго выезжает рядом со значком; при загрузке страницы не срабатывает
          const rp=t.querySelector('.rp');clearTimeout(rp._t);rp.classList.remove('on');
          if(was!==undefined&&BADGE[role]){rp.firstChild.textContent=ROLES[role].t;rp.classList.add('on');rp._t=setTimeout(()=>rp.classList.remove('on'),ROLE_PLATE_MS)}
        }
        t.querySelector('.nick span').textContent=s.nick||'—';
        t.querySelector('.st').innerHTML=st==='killed'?IC.cross+'<span>УБИТ</span>':st==='voted'?IC.hand+'<span>ЗАГОЛОСОВАН</span>':st==='removed'?IC.card+'<span>УДАЛЁН</span>':'';
        drawFouls(i);
      });
      // победители встают подряд по центру ряда; места считаются без сдвигов, поэтому повторный вызов ничего не ломает
      const wins=tiles.filter(t=>t.classList.contains('winner'));
      const W=tiles[0].offsetWidth,step=W+u.gap,start=(q('.row').clientWidth-(wins.length*step-u.gap))/2; // q('.row'): ниже в draw есть своя функция row
      tiles.forEach(t=>{const k=wins.indexOf(t);t.style.transform=k<0?'':`translateX(${start+k*step-t.offsetLeft}px)`});
      const nb=q('.nights'),ns=V.nights||[];
      const has=n=>(n.shot||'')!==''||(n.check||'')!==''||(n.don||'')!=='';
      const shown=ns.slice(0,ns.reduce((last,n,k)=>has(n)?k+1:last,0)); // столбец — ночь, поэтому пустая ночь посреди игры тоже остаётся
      nb.classList.toggle('on',shown.length>0);
      const chip=(seat,color)=>seat===''||seat==='miss'?'<span class="chip none">×</span>':`<span class="chip ${color(+seat)}">${+seat+1}</span>`;
      const row=(icon,cell)=>`<div class="nr"><span class="ni">${icon}</span>${shown.map(cell).join('')}</div>`;
      nb.innerHTML=shown.length?row(IC.shot,n=>chip(n.shot||'',vColor))+
        row(IC.hat,n=>chip(n.don||'',i=>(V.seats[i]||{}).role==='sheriff'?'sher':'nosher'))+
        row(IC.star,n=>chip(n.check||'',i=>(V.seats[i]||{}).role==='don'?'don':vTeam(i))):'';
      drawProtocol();
      drawResults(sc);
    };
    /* ---- экраны итогов с MafiaUniverse ---- */
    const ROLE_CHIP={'мирный':'red','шериф':'sher','мафия':'black','дон':'don'};
    const WIN_TEXT={red:'Победа мирных',black:'Победа мафии',draw:'Ничья'};
    let resSig='';
    function drawResults(sc){
      if(sc!=='gameres'&&sc!=='standings')return; // при уходе с экрана итогов таблица остаётся до конца анимации
      // перерисовка только при смене содержимого: повторная загрузка тех же итогов строки не дёргает
      const d=V.show,box=q('.resb'),sig=JSON.stringify([sc,d&&d.rows,d&&d.winner,V.showPage]);
      if(sig===resSig)return;resSig=sig;
      const base=stage.classList.contains('moving')?450:0; // при входе с экрана игры строки ждут, пока выедет таблица
      const ani=k=>` in" style="animation-delay:${base+k*45}ms`;
      box.className='resb '+(sc==='gameres'?'g':'t');
      const head=q('.resb .rh'),rt=q('.resb .rt');
      if(!d||!Array.isArray(d.rows)){head.innerHTML='';rt.innerHTML='<div class="rr"><span></span><span>Итоги ещё не загружены</span></div>';return}
      if(sc==='gameres'){
        const winner=['red','black','draw'].includes(d.winner)?d.winner:'';
        head.innerHTML=winner?`<span class="wn ${winner}${ani(0)}">${WIN_TEXT[winner]}</span>`:'';
        const won=r=>d.winner==='red'?/мирн|шериф/i.test(r.role):d.winner==='black'?/маф|дон/i.test(r.role):false;
        // роль видна по цвету номера, поэтому отдельной колонки нет
        rt.innerHTML=`<div class="rr hd${ani(0)}"><span></span><span>Игрок</span><span class="c">ПУ</span><span class="r">+</span><span class="r">−</span><span class="r">∑</span></div>`+
          d.rows.map((r,k)=>`<div class="rr${won(r)?' won':''}${ani(k+1)}"><span class="ch ${ROLE_CHIP[String(r.role).toLowerCase()]||''}">${esc(r.n)}</span><span>${esc(r.nick)}</span><span class="c">${esc(r.pu)}</span><span class="r">${esc(r.plus)}</span><span class="r">${esc([r.minus,r.tech].filter(Boolean).join(' / '))}</span><span class="r sum">${esc(r.sum)}</span></div>`).join('');
      }else{
        const pages=Math.max(1,Math.ceil(d.rows.length/RES_PAGE)),p=Math.min(V.showPage||0,pages-1);
        head.innerHTML='';
        // как в итоговой таблице MafiaUniverse: первые отстрелы, баллы за ЛХ, компенсация (Ci), допы и сумма
        rt.innerHTML=`<div class="rr hd${ani(0)}"><span class="c">#</span><span>Игрок</span><span class="r" title="Первых отстрелов">ПУ</span><span class="r">ЛХ</span><span class="r">Ci</span><span class="r">Допы</span><span class="r">∑</span></div>`+
          d.rows.slice(p*RES_PAGE,(p+1)*RES_PAGE).map((r,k)=>`<div class="rr${ani(k+1)}"><span class="pl${['1','2','3'].includes(String(r.place))?' p'+r.place:''}">${esc(r.place)}</span><span>${esc(r.nick)}</span><span class="r dim2">${esc(r.first)}</span><span class="r">${esc(r.lh)}</span><span class="r">${esc(r.ci)}</span><span class="r">${esc(r.dop)}</span><span class="r sum">${esc(r.sum)}</span></div>`).join('')+(pages>1?`<div class="pg">${p+1} / ${pages}</div>`:'');
      }
    }
    /* ---- таймер речи; выставленные и лучший ход показываются на самих плашках ---- */
    function drawFouls(i){
      const s=V.seats[i]||{},st=s.status||'alive',fo=+s.fouls||0,fc=tiles[i].querySelector('.fc');
      const visible=scene==='game'&&V.showFouls!==false&&fo>0&&(st==='alive'||st==='removed');
      fc.className='fc'+(visible?' on':'')+(fo>=4?' f4':fo===3?' f3':'');
      fc.textContent=visible?fo:'';
    }
    function drawProtocol(){
      const sp=V.timer?.speaker||'';
      q('.spk .sw').textContent=sp===''?'':`${+sp+1} · ${(V.seats[+sp]||{}).nick||''}`;
      q('.spk .sw').style.display=sp===''?'none':'';
      const speaker=scene==='game'&&timerClock.remaining()>0?sp:'';
      tiles.forEach((tile,i)=>tile.classList.toggle('speak',speaker===String(i)));
      tickTimer();
    }
    drawTimerUpdate=foul=>{
      if(foul)drawFouls(foul.seat);
      drawProtocol();
    };
    function tickTimer(){
      const t=V?.timer;if(!t)return;
      const ms=timerClock.remaining(),s=Math.ceil(ms/1000);
      const visible=ms>0&&!!t.speaker;
      q('.spk').classList.toggle('on',visible);
      if(!visible){q('.tile.speak')?.classList.remove('speak');return}
      const clock=q('.spk .clk'),text=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
      if(clock.textContent!==text)clock.textContent=text;
    }
    setInterval(tickTimer,200);
  }

  /* ---------- сцены: ожидание / победа ---------- */
  else{
    const CFG={
      wait:{bg:'bg-wait',sub:'',center:'<div class="sc-timer appear d2 hide" id="scTimer"></div>'},
      red:{bg:'bg-dim',sub:'КОМАНДА МИРНЫХ',center:'<div class="win red appear d2">ПОБЕДА МИРНЫХ</div>'},
      black:{bg:'bg-dim',sub:'КОМАНДА МАФИИ',center:'<div class="win black appear d2">ПОБЕДА МАФИИ</div>'}
    }[MODE];
    document.title={wait:'Ожидание',red:'Победа мирных',black:'Победа мафии'}[MODE];
    document.body.className='scene';
    document.body.innerHTML=`<div id="stage" class="${CFG.bg}">
      <div class="sc-label appear d1"><span id="scTitle"></span></div>
      <div class="sc-game appear d1" id="scGame"></div>
      ${CFG.center}
      <div class="sc-sub appear d3" id="scSub">${CFG.sub}</div>
      <div class="sc-cards appear d4" id="scCards"></div></div>`;
    const $=id=>document.getElementById(id);
    let sig='';
    let wEnd=0,wT=null;
    function tickTimer(){
      const el=$('scTimer');if(!el)return;
      const w=V&&V.wait;
      if(!w||!w.show){el.classList.add('hide');return}
      if(w!==wT){wT=w;const now=Date.now();wEnd=(w.sentAt||now)+w.remain;if(wEnd-now>w.remain+3000)wEnd=now+w.remain}
      const left=w.running?Math.max(0,wEnd-Date.now()):w.remain;
      let t=Math.ceil(left/1000);const h=Math.floor(t/3600),m=Math.floor(t%3600/60),sec=t%60;
      el.textContent=(h?h+':'+String(m).padStart(2,'0'):m)+':'+String(sec).padStart(2,'0');
      el.classList.toggle('zero',left<=0);el.classList.remove('hide');
    }
    if(MODE==='wait')setInterval(tickTimer,200);
    draw=function(){
      applyAccent(V&&V.accent);
      const title=V?V.title||'':'',g=V?gameText(V):'';
      $('scTitle').textContent=title;$('scTitle').parentElement.classList.toggle('hide',!title);
      $('scGame').textContent=g;$('scGame').classList.toggle('hide',!g);
      if(MODE==='wait')tickTimer();
      const list=[];
      if(V&&V.seats)V.seats.forEach((s,i)=>{
        if(!s.pid)return;const role=ROLES[s.role]?s.role:'civ';
        if(MODE!=='wait'&&ROLES[role].team===MODE)list.push({i,nick:s.nick,role,ph:photo(s.pid)||photo(s.ph)});
      });
      const ns=JSON.stringify(list.map(x=>[x.i,x.nick,x.role,x.ph?x.ph.length:0]));
      if(ns===sig)return;sig=ns;
      const roles=MODE!=='wait';
      $('scCards').innerHTML=list.map(x=>`<div class="card ${roles?`team-${ROLES[x.role].team} r-${x.role}`:''}">
        <div class="ph"${x.ph?` style="background-image:url('${x.ph}')"`:''}>${x.ph?'':SIL}</div><div class="ac"></div>
        <div class="bd">${roles?BADGE[x.role]||'':''}</div>
        <div class="bt"><div class="n">${x.i+1}</div><div class="nk"><span>${esc(x.nick)}</span></div></div></div>`).join('');
      $('scCards').classList.toggle('hide',!list.length);$('scSub').classList.toggle('hide',!list.length);
    };
  }
  draw();
  if(document.fonts)document.fonts.ready.then(()=>draw()); // ширина названия зависит от шрифта, а по ней худ ставит его в центр
  if (screenRoom) Net.connect({ role: 'screen', room: screenRoom });
}
