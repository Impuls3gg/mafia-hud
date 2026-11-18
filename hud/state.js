let S = null;
const photos = Object.create(null);
let renderFn = () => {};
let syncGame = () => {};

function commit() {
  syncGame();
  renderFn();
}
const seatPhoto=i=>photos[S.seats[i].pid]||null; // в пульте всегда обычное фото
const team=i=>ROLES[S.seats[i].role||'civ'].team; // игрок без роли считается мирным
