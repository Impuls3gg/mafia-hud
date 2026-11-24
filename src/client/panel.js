/* Адрес включает вкладку пульта, например /panel#design. */
const PANEL_TABS=[['game','Игра'],['players','Игроки'],['judge','Судья'],['design','Дизайн'],['obs','OBS']];
const tabHref = key => '#' + key;
const tabFromHash=()=>{const m=location.hash.match(/(?:^#|\/)(game|players|judge|design|obs)$/);return m?m[1]:'game'};
function startPanel({tournamentId}){
  document.body.className='panel';
  document.body.innerHTML=`
  <header class="p-head"><h1>Пульт оператора</h1>
    <a href="/tournaments/${tournamentId}/operator?game=${GAME_ID}" target="_top">Пульт турнира</a>
    <span id="pGameTitle"></span>
    <nav class="p-tabs" aria-label="Страницы пульта">${PANEL_TABS.map(([k,t])=>`<a href="${tabHref(k)}" data-tab="${k}">${t}</a>`).join('')}</nav>
    <span class="p-net conn"><span class="dot" id="hDot"></span><span id="hSt"></span></span>
  </header>
  <div id="syncError" class="muted" role="alert" hidden></div>
  <section class="page p-grid" data-page="game" aria-label="Игра">
    <div>
      <div class="box"><h2>Экран худа</h2>
        <div class="bar" id="scenes"><button data-a="scene" data-s="game">Игра</button><button data-a="scene" data-s="red">Победа мирных</button><button data-a="scene" data-s="black">Победа мафии</button></div>
        <div>
          <h3 class="sub">Итоговая таблица</h3>
          <div class="bar"><input id="shTour" inputmode="numeric" style="width:150px" placeholder="id турнира или ссылка" aria-label="id турнира MafiaUniverse">
            <button data-a="showRes" data-s="standings">Вывести итоговую таблицу</button><button data-a="refRes">↻ Обновить итоговую таблицу</button></div>
          <div class="bar"><button data-a="pgPrev" aria-label="Предыдущая страница таблицы">←</button><span id="shPage" class="muted"></span><button data-a="pgNext" aria-label="Следующая страница таблицы">→</button><span class="muted" id="shResSt"></span></div>
          <h3 class="sub">Результаты игры</h3>
          <div class="bar"><select id="shGame" aria-label="Игра MafiaUniverse"></select><input id="shGameUrl" style="width:200px" placeholder="или ссылка на игру" aria-label="Ссылка на игру MafiaUniverse">
            <button data-a="showGame" data-s="gameres">Выгрузить результаты игры</button></div>
          <div class="muted" id="shGamesHint"></div><div class="muted" id="shGameSt"></div>
        </div>
        <div class="muted" style="margin-top:8px">Худ переключается с анимацией. Итоговая таблица и результаты игры берутся с MafiaUniverse, когда игра там уже сохранена: кнопка скачивает данные и сразу выводит их на худ.</div>
      </div>
      <div class="box"><h2>Рассадка на игру</h2>
        <div class="scroll"><table class="pt"><thead><tr><th>№</th><th></th><th>Игрок</th><th>Роль</th><th>Статус</th><th>Фолы</th></tr></thead><tbody id="rows"></tbody></table></div>
        <div class="bar"><a href="/tournaments/${tournamentId}/admin?game=${GAME_ID}" target="_top">Настроить рассадку в админке</a></div>
        <div class="bar"><label><input type="checkbox" id="fFouls">Показывать фолы на плашках</label></div>
      </div>
    </div>
    <div>
      <div class="box"><h2>Ночи: отстрел и проверки</h2>
        <table class="nt"><thead><tr><th></th><th>Отстрел мафии</th><th>Проверка шерифа</th><th>Проверка дона</th><th></th></tr></thead><tbody id="nights"></tbody></table>
        <div class="bar" style="margin-top:8px"><button data-a="addNight">Добавить ночь</button><span class="muted">Результаты проверок определяются по ролям. На экране красный и чёрный показываются цветом номера, найденный шерифом дон — фиолетовым, у дона жёлтый номер означает, что он нашёл шерифа.</span></div>
      </div>
      <div class="box"><h2>Игра</h2>
        <div class="bar">Игра <button data-a="gameMinus" aria-label="Предыдущая игра">−</button>
          <input id="fGame" type="number" min="0" style="width:64px" aria-label="Номер игры">
          <button data-a="gamePlus" aria-label="Следующая игра">+</button><span class="muted">0 скрывает надпись.</span></div>
        <div class="bar"><button data-a="resetGame" class="warn">Сбросить протокол</button><span class="muted">Роли, статусы, фолы, ночи и результат этой игры будут сброшены. Рассадка сохранится.</span></div>
      </div>
    </div>
  </section>
  <section class="page p-grid" data-page="players" aria-label="Игроки">
    <div>
      <div class="box"><h2>MafiaUniverse</h2>
        <div>
          <div class="bar"><a class="mu-bm" id="muBm" href="#" title="Перетащите на панель закладок">Отправить в HUD</a><span class="muted">Загрузка списка игр: откройте раздел «Игры» турнира на MafiaUniverse и нажмите закладку. Рассадку выбранной игры можно открыть в админке.</span></div>
          <div class="bar"><a class="mu-bm" id="muFillBm" href="#" title="Перетащите на панель закладок">Заполнить протокол</a><span class="muted">Экспорт игры: откройте на MafiaUniverse редактирование игры и нажмите эту закладку. Заполнятся роли, фолы, первый убиенный с лучшим ходом, допы и минусы, победитель и заметка с голосованиями. Сохраните на сайте сами.</span></div>
          <div id="mu" style="margin-top:8px"></div>
        </div>

      </div>
    </div>
    <div>
      <div class="box"><h2>Игроки игры</h2>
        <a href="/tournaments/${tournamentId}/participants" target="_top">Участники и фотографии турнира</a>
        <div class="rl" id="roster"></div>
        <div class="bar" style="margin-top:8px"><button data-a="addOne">Добавить игрока</button></div>
        <div style="margin-top:10px">
          <label class="muted" for="bulk">Добавить списком, по одному нику в строке:</label>
          <textarea id="bulk" style="margin-top:4px"></textarea>
          <div class="bar" style="margin-top:6px"><button data-a="addBulk">Добавить список</button></div>
        </div>
      </div>
    </div>
  </section>
  <section class="page p-grid" data-page="judge" aria-label="Судья">
    <div>
      <div class="box"><h2>Судья с телефона</h2>

        <div class="muted" id="jSt" style="margin-top:6px">Не подключено</div>
        <div class="bar" style="margin-top:8px"><input id="jLink" style="flex:1" readonly aria-label="Ссылка для судьи"><button data-a="jCopy">Копировать</button><button data-a="jNew">Новая ссылка</button><a id="jOpen">Открыть судью</a></div>
        <div class="muted" style="margin-top:6px">Отправьте ссылку судье: по ней он выдаёт роли, ставит фолы и отмечает ночные действия с телефона. Ссылка даёт управление игрой, поэтому не публикуйте её.</div>

      </div>
    </div>
    <div></div>
  </section>
  <section class="page p-grid" data-page="design" aria-label="Дизайн">
    <div>
      <div class="box"><h2>Оформление игры</h2>
        <a href="/tournaments/${tournamentId}/design" target="_top">Общий дизайн OBS для турнира</a>
        <input id="fTitle" style="width:100%" placeholder="Например: Кубок города, 2 тур" aria-label="Название турнира">
        <div class="ac-row"><span>Акцентный цвет</span><input type="color" id="fAccent" aria-label="Акцентный цвет турнира">
          <span id="swatches" class="bar" style="gap:4px"></span><button data-a="accentReset">Сбросить</button></div>
        <div class="muted" style="margin-top:4px">Цвет полосок у названия и таблицы ночей и заголовков сцен. Цвета команд (красные, чёрные) не меняются.</div>
      </div>
      <div class="box"><h2>Плашки</h2>
        <div class="sz" id="sizes"></div>
        <div class="bar" style="margin-top:8px"><button data-a="uiReset">Сбросить</button><span class="muted">Меняется сразу в оверлее, смотрите в превью. Прозрачность действует на убитых, заголосованных и удалённых.</span></div>
      </div>
    </div>
    <div>
      <div class="box"><h2>Превью оверлея</h2>
        <div class="bar"><button id="pvBtn">Показать превью</button><span class="muted">Для проверки. В OBS лучше не включать.</span></div>
        <div id="pvWrap" style="display:none;margin-top:8px"><div class="pv" id="pv"></div></div>
      </div>
    </div>
  </section>
  <section class="page p-grid" data-page="obs" aria-label="OBS">
    <div>
      <div class="box conn"><h2 id="cTitle">Связь с сервером</h2>
        <div><span class="dot" id="cDot"></span><span class="st" id="cSt">Подключение…</span></div>
        <div class="muted" id="cHint" style="margin-top:4px"></div>

        <div class="disp" id="cDisp"></div>
      </div>
    </div>
    <div>
      <div class="box"><h2>Худ в OBS через сервер</h2>
        <div class="muted">Вставьте первую ссылку в URL источника «Браузер» в OBS: худ сам показывает и игру, и экраны победы. Две другие ссылки — отдельные экраны победы, если они ещё нужны. Ссылки показывают роли игроков, поэтому не публикуйте их.</div>
        <div class="bar" style="margin-top:8px"><input id="hLink" style="flex:1" readonly aria-label="Ссылка на худ"><button data-a="hCopy">Копировать</button></div>
        <div class="bar" style="margin-top:6px"><input id="rLink" style="flex:1" readonly aria-label="Ссылка на экран победы мирных"><button data-a="rCopy">Копировать</button></div>
        <div class="bar" style="margin-top:6px"><input id="bLink" style="flex:1" readonly aria-label="Ссылка на экран победы мафии"><button data-a="bCopy">Копировать</button></div>
        <div class="bar" style="margin-top:6px"><button data-a="hNew">Новые ссылки</button></div>
      </div>
    </div>
  </section>`;
  const $=s=>document.querySelector(s);
  const tb=$('#rows');
  S.seats.forEach((_,i)=>{
    const tr=document.createElement('tr');tr.dataset.i=i;
    tr.innerHTML=`<td class="n">${i+1}</td><td><div class="mini"></div></td>
      <td><select class="who" data-f="pid" aria-label="Игрок на месте ${i+1}" disabled></select></td>
      <td class="rc"><select data-f="role" aria-label="Роль, место ${i+1}"><option value="">Нет роли</option><option value="civ">Мирный</option><option value="sheriff">Шериф</option><option value="mafia">Мафия</option><option value="don">Дон</option></select></td>
      <td class="stc"><select data-f="status" aria-label="Статус, место ${i+1}"><option value="alive">В игре</option><option value="voted">Заголосован</option><option value="removed">Удалён</option></select><span class="killed"></span></td>
      <td class="fo"><button data-a="foulMinus" data-i="${i}" aria-label="Снять фол, место ${i+1}">−</button><span class="fn"></span><button data-a="foulPlus" data-i="${i}" aria-label="Фол, место ${i+1}">+</button></td>`;
    tb.appendChild(tr);
  });

  function setPhoto(id, data) {
    if (!Net.online()) {
      alert('Нет связи с сервером, фото не изменилось.');
      return;
    }
    Net.send({ kind: 'photo', pid: id, data: data || null });
  }
  const seatOf=id=>S.seats.findIndex(s=>s.pid===id);

  const A={
    accent(el){S.accent=el.dataset.c},
    accentReset(){S.accent=ACCENT_DEF},
    scene(el){Net.send({kind:'muCancel'});S.scene=el.dataset.s},
    uiReset(){S.ui=Object.assign({},UI_DEF)},
    addNight(){S.nights.push({shot:'',check:'',don:''})},
    delNight(el){S.nights.splice(+el.dataset.k,1);if(!S.nights.length)S.nights.push({shot:'',check:'',don:''})},
    resetGame(){if(confirm('Сбросить протокол этой игры? Рассадка сохранится.'))resetGame()},
    gamePlus(){S.game=(+S.game||0)+1},
    gameMinus(){S.game=Math.max(0,(+S.game||0)-1)},
    muSelect(el){const g=S.mu&&S.mu.games.find(x=>x.key===el.dataset.k);if(g)selectMuGame(g)},
    muAdmin(el){
      const game=S.mu?.games.find(g=>g.key===el.dataset.k);
      if(!game?.ready)return;
      const seats=new URLSearchParams({seating:JSON.stringify(game.seats)});
      window.top.location.href='/tournaments/'+tournamentId+'/admin?game='+GAME_ID+'#'+seats;
    },
    muNext(){muStep(1)},
    muPrev(){muStep(-1)},
    muForget(){if(confirm('Забыть турнир MafiaUniverse? Рассадка на местах останется.'))S.mu=null},
    // итоги с MafiaUniverse скачивает сервер; ответ приходит сообщением muFetched
    // результаты игры — из списка турнира или по ссылке вида mafiauniverse.org/Games/Details/… (подойдёт и /Games/Edit/…); после загрузки худ сам переключается на них
    showGame(){
      const link=($('#shGameUrl').value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)||[])[0];
      if($('#shGameUrl').value.trim()&&!link){showSt.game='В ссылке нет кода игры. Скопируйте адрес страницы игры на MafiaUniverse.';return}
      const id=link||$('#shGame').value;
      if(!id){showSt.game='Выберите игру из списка или вставьте ссылку на неё.';return}
      showNow('game',id);
    },
    showRes(){const id=tourId();if(!id){showSt.results='Укажите id турнира или ссылку на него.';return}showNow('results',id)},
    refRes(){const r=(S.show||{}).results,id=tourId()||(r&&r.id);if(!id){showSt.results='Сначала выведите итоговую таблицу.';return}requestShow('results',id,'refresh')},
    pgPrev(){S.showPage=Math.max(0,(+S.showPage||0)-1)},
    pgNext(){const n=((S.show||{}).results||{rows:[]}).rows.length;S.showPage=Math.min(Math.max(0,Math.ceil(n/RES_PAGE)-1),(+S.showPage||0)+1)},
    foulPlus(el){const s=S.seats[+el.dataset.i];s.fouls=Math.min(4,(+s.fouls||0)+1)},
    foulMinus(el){const s=S.seats[+el.dataset.i];s.fouls=Math.max(0,(+s.fouls||0)-1)},
    addOne(){const id=newId();S.roster.push({id,nick:'Новый игрок'});pendingFocus=id},
    addBulk(){const lines=$('#bulk').value.split('\n').map(x=>x.trim()).filter(Boolean);
      lines.forEach(n=>S.roster.push({id:newId(),nick:n}));$('#bulk').value=''},
    delPerson(el){const id=el.dataset.id,p=person(id);if(!p)return;
      if(seatOf(id)>=0)return;
      if(!confirm(`Удалить игрока «${p.nick}» из этой игры?`))return;
      removePlayer(S,id);
      syncGame({kind:'deletePlayer',pid:id})},
    delPhoto(el){setPhoto(el.dataset.id,null)}
  };
  let pendingFocus=null;
  if(S.nights.some(n=>n.shot==='miss')){S.nights.forEach(n=>{if(n.shot==='miss')n.shot=''});commit()}
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-a]');if(!b)return;
    const fn=A[b.dataset.a];if(fn){fn(b);commit()}
  });
  tb.addEventListener('change',e=>{
    const i=+e.target.closest('tr').dataset.i,f=e.target.dataset.f,v=e.target.value;
    if(f==='role')S.seats[i].role=v;
    if(f==='status')S.seats[i].status=v;
    commit();
  });
  $('#roster').addEventListener('input',e=>{
    const p=person(e.target.dataset.id);if(!p)return;
    if(e.target.classList.contains('rn')){p.nick=e.target.value;commit()}
    else if(e.target.classList.contains('rmu')){p.mu=e.target.value.trim();commit()}
  });
  $('#roster').addEventListener('change',async e=>{
    if(e.target.type!=='file')return;
    const id=e.target.dataset.id,file=e.target.files&&e.target.files[0];e.target.value='';
    if(!file)return;
    try{const data=await processImage(file);if(person(id.split('.')[0]))setPhoto(id,data)}catch(err){alert(err.message)}
  });
  $('#nights').addEventListener('change',e=>{
    const k=+e.target.dataset.k,f=e.target.dataset.f;
    if(S.nights[k]&&f){
      S.nights[k][f]=e.target.value;
      nextNight();
      commit();
    }
  });
  $('#sizes').innerHTML=UI_FIELDS.map(([k,l,mn,mx,st])=>`<label for="u_${k}">${l}</label><input type="range" id="u_${k}" data-u="${k}" min="${mn}" max="${mx}" step="${st}"><output id="o_${k}"></output>`).join('');
  $('#sizes').addEventListener('input',e=>{const k=e.target.dataset.u;if(k){S.ui[k]=+e.target.value;commit()}});
  $('#fTitle').addEventListener('input',e=>{S.title=e.target.value;commit()});
  $('#swatches').innerHTML=ACCENTS.map(c=>`<button class="ac-sw" data-a="accent" data-c="${c}" style="background:${c}" title="${c}" aria-label="Цвет ${c}"></button>`).join('');
  $('#fAccent').addEventListener('input',e=>{S.accent=e.target.value;commit()});
  $('#fGame').addEventListener('input',e=>{const n=parseInt(e.target.value,10);S.game=isNaN(n)||n<0?0:n;commit()});

  /* ---- рассадка из MafiaUniverse: закладка присылает все игры турнира, пульт сажает игроков выбранного стола ---- */
  function resetGame(){
    Net.send({kind:'muCancel'});
    S.seats.forEach(s=>Object.assign(s,{role:'',status:'alive',fouls:0,bonus:0,pen:0,tech:0,techFouls:[]}));
    S.nights=[{shot:'',check:'',don:''}];S.scene='game';Object.assign(S,protocolDefaults());
  }
  const muList=()=>S.mu?S.mu.games.filter(g=>g.table===S.mu.table):[];
  const muTables=()=>S.mu?[...new Set(S.mu.games.map(g=>g.table))].sort((a,b)=>a-b):[];
  let muNote='';
  const notReady=g=>`У игры «${g.title}» на MafiaUniverse ещё нет рассадки. Когда организатор её сделает, нажмите закладку ещё раз.`;
  function selectMuGame(g){
    S.mu.cur=g.key;
    $('#shGame').value=g.key;
    muNote=g.ready?`Выбрана игра «${g.title}».`:notReady(g);
  }
  function muStep(d){
    const list=muList();if(!list.length){muNote='Сначала выберите стол.';return}
    const k=list.findIndex(g=>g.key===S.mu.cur),g=list[k<0?(d>0?0:list.length-1):k+d];
    if(g)selectMuGame(g);else muNote=d>0?'Это последняя игра стола.':'Это первая игра стола.';
  }
  function muCurrent(){
    const list=muList(),g=list.find(x=>x.key===S.mu.cur)||list.find(x=>!x.ended)||list[0];
    if(!g)return 'У стола пока нет игр.';
    selectMuGame(g);
    return muNote;
  }
  muExport=()=>{
    muNote='Протокол отправлен на MafiaUniverse. Вернитесь на вкладку сайта, проверьте и сохраните.';renderFn();
    return muExportData();
  };
  const showSt={game:'',results:''},showRequests={};
  let requestId=0;
  const tourId=()=>($('#shTour').value.match(/(\d+)\/?\s*$/)||[])[1]||'';
  function requestShow(what,id,mode){
    if(!Net.online()){showSt[what]='Нет связи с сервером. Повторите запрос после подключения.';return}
    const request={kind:'muFetch',what,id,mode,requestId:++requestId};
    showRequests[what]=request;
    showSt[what]=mode==='refresh'?'Обновляю…':'Загружаю…';
    Net.send(request);
  }
  const showNow=(what,id)=>requestShow(what,id,'show');
  const prefetch=(what,id)=>{if(id&&Net.online())Net.send({kind:'muFetch',what,id,mode:'prefetch',requestId:++requestId})};
  $('#shGame')?.addEventListener('change',e=>prefetch('game',e.target.value));
  $('#shTour')?.addEventListener('change',()=>prefetch('results',tourId()));
  Net.on(m=>{
    if(m.kind!=='muFetched'||showRequests[m.what]?.requestId!==m.requestId||showRequests[m.what]?.id!==m.id)return;
    delete showRequests[m.what];
    showSt[m.what]=m.ok?`Загружено: ${m.title||''}, строк ${m.rows}.`:m.error;
    renderFn();
  });
  Net.onStatus(status=>{
    if(status!=='off')return;
    for(const what of Object.keys(showRequests)){
      delete showRequests[what];
      showSt[what]='Связь прервалась. Повторите загрузку после подключения.';
    }
    renderFn();
  });
  function renderShow(){
    const sel=$('#shGame'),games=S.mu?S.mu.games:[],opts=games.length?games.map(g=>`<option value="${esc(g.key)}">${esc(g.title)}${g.ended?' · сыграна':''}</option>`).join(''):'<option value="">— турнир не загружен —</option>';
    if(sel._o!==opts&&document.activeElement!==sel){sel.innerHTML=opts;sel._o=opts;if(S.mu&&S.mu.cur)sel.value=S.mu.cur}
    const tour=$('#shTour');if(!tour.value&&S.mu&&S.mu.id)tour.value=S.mu.id;
    // список игр на MafiaUniverse виден только после входа, поэтому он приходит из закладки «Отправить в HUD»
    const want=(tour.value.match(/(\d+)\/?\s*$/)||[])[1]||'';
    $('#shGamesHint').textContent=!S.mu?'Список игр турнира подтягивается закладкой «Отправить в HUD» (страница «Игроки»): на MafiaUniverse он виден только после входа. Можно и просто вставить ссылку на игру.'
      :want&&want!==S.mu.id?`В списке игры турнира №${S.mu.id}. Чтобы выбрать игры турнира №${want}, нажмите закладку «Отправить в HUD» на странице его игр.`:'';
    const d=(S.show||{}).results,pages=d?Math.max(1,Math.ceil(d.rows.length/RES_PAGE)):0;
    $('#shPage').textContent=pages>1?`страница ${Math.min(+S.showPage||0,pages-1)+1} из ${pages}`:'';
    const g=(S.show||{}).game;
    $('#shGameSt').textContent=showSt.game||(g?`Загружена: ${g.title}`:'');
    $('#shResSt').textContent=showSt.results||(d?`Загружена: ${d.title}, игроков ${d.rows.length}`:'');
    // кнопка показанного экрана итогов подсвечена, как кнопки сцен
    document.querySelectorAll('[data-a=showRes],[data-a=showGame]').forEach(b=>b.classList.toggle('on',b.dataset.s===S.scene));
  }
  $('#shTour')?.addEventListener('input',renderShow); // подсказка про список игр меняется сразу
  let muSig='';
  muTake=d=>{
    const sig=JSON.stringify(d);if(sig===muSig)return; // закладка повторяет сообщение, пока пульт не ответит
    muSig=sig;
    const was=S.mu&&S.mu.id===d.id?S.mu:null;
    S.mu=Object.assign(d,{table:was?was.table:0,cur:was?was.cur:'',at:Date.now()});
    const tables=muTables();
    if(!tables.includes(S.mu.table))S.mu.table=tables.length===1?tables[0]:0;
    muNote=`Получено игр: ${d.games.length}. `+(S.mu.table?muCurrent():'Выберите свой стол.');
    commit();
    prefetch('results',d.id);
  };
  $('#mu').addEventListener('change',e=>{
    if(e.target.id!=='muTable'||!S.mu)return;
    S.mu.table=+e.target.value;
    muNote=S.mu.table?muCurrent():'';
    commit();
  });
  {
    const bm=$('#muBm');bm.href=muBookmarklet(BASE+'/panel');
    const fb=$('#muFillBm');fb.href=muFillBookmarklet(BASE+'/panel');
    fb.addEventListener('click',e=>{e.preventDefault();alert('Эту кнопку нужно перетащить на панель закладок браузера, а нажимать уже на странице протокола игры на MafiaUniverse.')});
    bm.addEventListener('click',e=>{e.preventDefault();alert('Эту кнопку нужно перетащить на панель закладок браузера, а нажимать уже на сайте MafiaUniverse.')});
  }
  function renderMu(){
    const box=$('#mu');
    if(!S.mu){box.innerHTML=`<div class="muted">Турнир ещё не загружен.</div>${muNote?`<div class="muted" style="margin-top:4px">${esc(muNote)}</div>`:''}`;return}
    const list=muList();
    const opts=`<option value="0">— выберите —</option>`+muTables().map(t=>`<option value="${t}"${t===S.mu.table?' selected':''}>Стол ${t}</option>`).join('');
    box.innerHTML=`<div><b>${esc(S.mu.title||'Турнир')}</b> <span class="muted">· игр: ${S.mu.games.length}${S.mu.url?` · <a href="${esc(S.mu.url)}" target="_blank" rel="noopener" style="color:inherit">MafiaUniverse</a>`:''}</span></div>
      <div class="bar" style="margin-top:6px">Стол <select id="muTable" aria-label="Стол на MafiaUniverse">${opts}</select>
        <button data-a="muPrev">← Предыдущая</button><button data-a="muNext">Следующая →</button><button data-a="muForget" class="warn">Забыть турнир</button></div>
      ${muNote?`<div class="muted" style="margin-top:6px" role="status">${esc(muNote)}</div>`:''}
      ${list.length?`<table class="mt">${list.map(g=>`<tr class="${g.key===S.mu.cur?'cur':''}"><td>${esc(g.round)}</td><td class="muted">${esc(g.judge)}</td><td>${g.ended?'<span class="ok">сыграна</span>':g.ready?'':'<span class="muted">нет рассадки</span>'}</td>
        <td class="act"><button data-a="muSelect" data-k="${esc(g.key)}">Выбрать</button>
        <button data-a="muAdmin" data-k="${esc(g.key)}"${g.ready?'':' disabled'}>Рассадка в админке</button></td></tr>`).join('')}</table>`:''}`;
  }
  $('#fFouls')?.addEventListener('change',e=>{S.showFouls=e.target.checked;commit()});

  let pvOn=false;
  $('#pvBtn')?.addEventListener('click',()=>{
    pvOn=!pvOn;$('#pvWrap').style.display=pvOn?'block':'none';$('#pvBtn').textContent=pvOn?'Скрыть превью':'Показать превью';
    const pv=$('#pv');
    if(pvOn&&!pv.firstChild){const f=document.createElement('iframe');f.src=BASE+'/hud#'+S.judge.hud;f.title='Превью оверлея';pv.appendChild(f);fitPv()}
    if(!pvOn)pv.innerHTML='';
  });
  function fitPv(){const pv=$('#pv'),f=pv?.querySelector('iframe');if(f)f.style.transform=`scale(${pv.clientWidth/1920})`}
  function showTab(t){
    document.querySelectorAll('.page').forEach(p=>p.classList.toggle('on',p.dataset.page===t));
    document.querySelectorAll('.p-tabs a').forEach(a=>{const on=a.dataset.tab===t;a.classList.toggle('on',on);if(on)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
    fitPv(); // у скрытой страницы превью нулевой ширины
  }
  addEventListener('hashchange',()=>showTab(tabFromHash()));
  showTab(tabFromHash());
  addEventListener('resize',fitPv);

  const setVal=(el,v)=>{if(document.activeElement!==el&&el.value!==String(v))el.value=v};
  const paintMini=(el,p)=>{if(el._p===p)return;el._p=p;el.style.backgroundImage=p?`url("${p}")`:'none';el.innerHTML=p?'':SIL};
  let rosterSig='';
  renderFn=function(){
    $('#pGameTitle').textContent=S.title;
    const judgeUrl=BASE+'/judge#'+S.judge.room;
    setVal($('#jLink'),judgeUrl);
    $('#jOpen').href=judgeUrl;
    const sorted=[...S.roster].sort((a,b)=>a.nick.localeCompare(b.nick,'ru'));
    const opts='<option value="">— свободно —</option>'+sorted.map(r=>`<option value="${esc(r.id)}">${esc(r.nick)}</option>`).join('');
    S.seats.forEach((s,i)=>{
      const tr=tb.children[i],st=statusOf(i);
      tr.className=st!=='alive'?'out':'';
      paintMini(tr.querySelector('.mini'),seatPhoto(i));
      const who=tr.querySelector('[data-f=pid]');
      if(document.activeElement!==who){if(who._o!==opts){who.innerHTML=opts;who._o=opts}who.value=s.pid}
      setVal(tr.querySelector('[data-f=role]'),s.role);
      tr.querySelector('.rc').className='rc rc-'+(s.role==='sheriff'?'gold':s.role==='don'?'don':s.role?ROLES[s.role].team:'none');
      const sel=tr.querySelector('[data-f=status]'),kl=tr.querySelector('.killed'),fo=+s.fouls||0,fn=tr.querySelector('.fn');
      if(st==='killed'){sel.style.display='none';kl.textContent=`Убит (ночь ${shotNight(i)+1})`}
      else if(s.techFouls?.length===2){sel.style.display='none';kl.textContent='Удалён (2 техфола)'}
      else if(fo>=4){sel.style.display='none';kl.textContent='Удалён (4 фола)'}
      else{sel.style.display='';kl.textContent='';setVal(sel,s.status==='voted'||s.status==='removed'?s.status:'alive')}
      fn.textContent=fo;fn.className='fn'+(fo>=4?' f4':fo===3?' f3':'');
    });
    renderMu();
    setVal($('#fGame'),S.game);
    for(const [id, route] of [['#hLink','/hud'],['#rLink','/win-civilians'],['#bLink','/win-mafia']]){
      setVal($(id),BASE+route+'#'+S.judge.hud);
    }
    renderShow();
    const scene=SCENES.includes(S.scene)?S.scene:'game';
    $('#scenes').querySelectorAll('button').forEach(b=>{const on=b.dataset.s===scene;b.classList.toggle('on',on);b.setAttribute('aria-pressed',on)});
    setVal($('#fTitle'),S.title);setVal($('#fAccent'),okColor(S.accent)?S.accent.toLowerCase():ACCENT_DEF);$('#fFouls').checked=S.showFouls!==false;
    UI_FIELDS.forEach(([k,,,,,un])=>{const v=S.ui[k]??UI_DEF[k];setVal($('#u_'+k),v);$('#o_'+k).textContent=un==='×'?(+v).toFixed(2)+'×':v+(un==='%'?'%':' px')});

    const sig=S.roster.map(r=>r.id).join(',');
    const rl=$('#roster');
    if(sig!==rosterSig){
      rosterSig=sig;
      rl.innerHTML=S.roster.length?S.roster.map(r=>({...r,id:esc(r.id)})).map(r=>`<div class="rr" data-id="${r.id}">
        <label class="thumb" data-k="${r.id}" title="Загрузить обычное фото"><input type="file" accept="image/*" data-id="${r.id}" aria-label="Обычное фото игрока"><span>+</span></label>
        <button data-a="delPhoto" data-id="${r.id}" title="Удалить фото" aria-label="Удалить обычное фото" style="padding:1px 6px">×</button>
        <div class="rm"><div class="rt"><input class="rn" data-id="${r.id}" aria-label="Ник" style="flex:1">
          <span class="seat"></span>
          <button data-a="delPerson" data-id="${r.id}" class="warn" aria-label="Удалить игрока">Удалить</button></div>
          <div class="rt"><input class="rmu" data-id="${r.id}" placeholder="ник на MafiaUniverse" aria-label="Ник на MafiaUniverse" title="По этому нику импорт находит игрока, а на худе показывается ник выше"></div>
          <div class="rslots">${Object.keys(ROLES).map(k=>`<div class="rslot"><label class="thumb sm" data-k="${r.id}.${k}" title="Фото для роли «${ROLES[k].t}»"><input type="file" accept="image/*" data-id="${r.id}.${k}" aria-label="Фото для роли ${ROLES[k].t}"><span>${ROLES[k].t.slice(0,3)}</span></label><button data-a="delPhoto" data-id="${r.id}.${k}" title="Удалить фото" aria-label="Удалить фото для роли ${ROLES[k].t}">×</button></div>`).join('')}</div></div></div>`).join('')
        :'<div class="muted">Список пуст. Добавьте игроков кнопкой ниже.</div>';
    }
    rl.querySelectorAll('.rr').forEach(el=>{
      const id=el.dataset.id,p=person(id);if(!p)return;
      setVal(el.querySelector('.rn'),p.nick);
      setVal(el.querySelector('.rmu'),p.mu||'');
      el.querySelectorAll('label.thumb').forEach(th=>{
        const ph=photos[th.dataset.k]||null;
        if(th._p!==ph){th._p=ph;th.style.backgroundImage=ph?`url("${ph}")`:'none';th.classList.toggle('has',!!ph)}
        th.nextElementSibling.style.visibility=ph?'visible':'hidden';
      });
      const si=seatOf(id);el.querySelector('.seat').textContent=si>=0?'место '+(si+1):'';
      el.querySelector('[data-a=delPerson]').disabled=si>=0;
    });
    if(pendingFocus){const inp=rl.querySelector(`.rn[data-id="${CSS.escape(pendingFocus)}"]`);pendingFocus=null;if(inp){inp.focus();inp.select();inp.scrollIntoView({block:'nearest'})}}

    const po=S.seats.map((_,i)=>`<option value="${i}">№${i+1} ${esc(seatNick(i))}</option>`).join('');
    $('#nights').innerHTML=S.nights.map((n,k)=>{
      let rs='',rd='';
      if((n.check||'')!==''){const tm=team(+n.check),dn=S.seats[+n.check].role==='don';rs=dn?'<span class="rs don">дон</span>':`<span class="rs ${tm}">${tm==='black'?'чёрный':'красный'}</span>`}
      if((n.don||'')!==''){const sh=S.seats[+n.don].role==='sheriff';rd=`<span class="rs ${sh?'gold':''}">${sh?'шериф':'не шериф'}</span>`}
      return `<tr><td>Ночь ${k+1}</td>
        <td><select data-k="${k}" data-f="shot" aria-label="Отстрел, ночь ${k+1}"><option value="">—</option>${po}</select></td>
        <td><div class="bar" style="flex-wrap:nowrap"><select data-k="${k}" data-f="check" aria-label="Проверка шерифа, ночь ${k+1}"><option value="">—</option>${po}</select>${rs}</div></td>
        <td><div class="bar" style="flex-wrap:nowrap"><select data-k="${k}" data-f="don" aria-label="Проверка дона, ночь ${k+1}"><option value="">—</option>${po}</select>${rd}</div></td>
        <td><button data-a="delNight" data-k="${k}" aria-label="Удалить ночь">×</button></td></tr>`;
    }).join('');
    document.querySelectorAll('#nights select').forEach(s=>{s.value=S.nights[+s.dataset.k][s.dataset.f]??''});
  };

  const newRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  A.jNew = () => {
    if (confirm('Создать новую ссылку? Старая перестанет работать.')) S.judge.room = newRoom();
  };
  A.hNew = () => {
    if (confirm('Создать новые ссылки для OBS? Старые перестанут работать.')) S.judge.hud = newRoom();
  };
  const copy = id => {
    $(id).select();
    document.execCommand('copy');
  };
  A.jCopy = () => copy('#jLink');
  A.hCopy = () => copy('#hLink');
  A.rCopy = () => copy('#rLink');
  A.bCopy = () => copy('#bLink');

  const seen={};
  const NAMES={overlay:'HUD',red:'Победа мирных',black:'Победа мафии'};
  function drawDisp(){
    const now=Date.now();
    $('#cDisp').innerHTML='Экраны: '+Object.keys(NAMES).map(k=>{
      const on=seen[k]&&now-seen[k]<40000;
      return `<span class="${on?'on':'off'}">${on?'●':'○'} ${NAMES[k]}</span>`;
    }).join('');
  }
  Net.on(m=>{if(m.kind==='hello'||m.kind==='pong'){seen[m.mode]=Date.now();drawDisp()}});
  setInterval(()=>{Net.send({kind:'ping'});drawDisp()},15000);
  drawDisp();Net.send({kind:'ping'});
  const ST = {
    ok: ['ok', 'Подключено к серверу', ''],
    connecting: ['wait', 'Подключение…', ''],
    off: ['bad', 'Нет связи с сервером', 'Изменения отправятся, когда связь вернётся.']
  };
  // связь видна в шапке на любой странице, а подробности — на странице «OBS»
  const showNet=s=>{
    const x=ST[s]||ST.off;
    $('#cDot').className='dot '+x[0];$('#cSt').textContent=x[1];$('#cHint').textContent=x[2];
    $('#hDot').className='dot '+x[0];$('#hSt').textContent=x[1];
  };
  Net.onStatus(showNet);showNet(Net.status);
  renderFn();
  if(muInbox){const d=muInbox;muInbox=null;muTake(d)} // закладка успела прислать рассадку, пока пульт ждал пароль
}

/* ---- пульт на сервере: игру присылает сервер, сюда приходят и правки судьи ---- */
function connectPanel(){
  const client=Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  const pending=[];
  let base=null,draft=null,inFlight=null,seq=0,started=false,retryTimer,attempted=false;
  const open = key => Net.connect({ role: 'host', key });
  function login(text){
    if(!started)document.body.className='panel';
    if(!document.getElementById('login'))document.body.insertAdjacentHTML('afterbegin',`<form class="box login" id="login"><h2>Пульт</h2>
      <input id="lKey" type="password" autocomplete="current-password" placeholder="Пароль сервера" aria-label="Пароль сервера" required>
      <button>Войти</button><div class="muted" id="lSt" role="status"></div></form>`);
    document.getElementById('lSt').textContent=text;
    document.getElementById('lKey').focus();
    document.getElementById('login').onsubmit=e=>{e.preventDefault();attempted=true;open(document.getElementById('lKey').value)};
  }
  function report(error=''){
    const notice=document.getElementById('syncError');
    if(notice){notice.textContent=error;notice.hidden=!error}
  }
  function flush(){
    if(!Net.online()||!base||inFlight||retryTimer||!pending.length)return;
    const {message}=pending[0];
    inFlight=message.seq;
    Net.send({...message,client,revision:base.revision});
  }
  syncGame=command=>{
    if(!draft)return;
    const ops=diffState(draft,S);
    if(command||ops.length){
      draft=structuredClone(S);
      pending.push({message:structuredClone({...command||{kind:'patch',ops},seq:++seq})});
    }
    flush();
  };
  Net.onStatus(st=>{
    if(st!=='ok'){
      inFlight=null;
      base=null;
      clearTimeout(retryTimer);
      retryTimer=null;
    }
    if(st==='badkey')login(attempted?'Неверный пароль':'');
    else if(st==='limited')login('Слишком много попыток входа. Повторите через минуту.');
    else if(st==='off'&&!started&&document.getElementById('lSt'))document.getElementById('lSt').textContent='Нет связи с сервером, повторяю…';
  });
  Net.on(m=>{
    if(m.kind==='game'){
      if(m.hello){
        Object.keys(photos).forEach(k=>delete photos[k]);
        document.getElementById('login')?.remove();
      }
      if(inFlight!==null&&m.ack===inFlight){
        inFlight=null;
        if(m.error)report(m.error);
        if(m.retry){
          retryTimer=setTimeout(()=>{retryTimer=null;flush()},2000);
        }else{
          pending.shift();
        }
      }
      base=m.S;
      S=structuredClone(base);
      for(const {message} of pending){
        if(message.kind==='deletePlayer')removePlayer(S,message.pid);
        else applyOps(S,message.ops);
      }
      draft=structuredClone(S);
      if(!started){started=true;startPanel(m.scope)}
      flush();renderFn();
    }
    else if(m.kind==='photo'){if(m.data)photos[m.pid]=m.data;else delete photos[m.pid];renderFn()}
    else if(m.kind==='error')report(m.error);
    else if(m.kind==='peers'&&started)document.getElementById('jSt').textContent=m.judge?'Судья на связи':'Судья ещё не зашёл';
  });
  open();
}
if (MODE === 'panel') connectPanel();
