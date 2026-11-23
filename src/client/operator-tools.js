const UI_FIELDS = [
  ['th', 'Высота плашек игроков', 120, 400, 2, 'px'],
  ['ts', 'Размер подписей на плашках', .6, 1.8, .05, '×'],
  ['gap', 'Промежуток между плашками', 0, 40, 1, 'px'],
  ['mb', 'Отступ плашек от низа', 0, 200, 1, 'px'],
  ['side', 'Отступ плашек от краёв', 0, 200, 1, 'px'],
  ['ns', 'Размер таблицы ночей', .5, 1.6, .05, '×'],
  ['is', 'Размер плашки с названием', .5, 1.6, .05, '×'],
  ['ot', 'Прозрачность выбывших игроков', 0, 100, 5, '%'],
];
const ACCENTS = ['#c41e3a', '#e8590c', '#f2c230', '#2f9e44', '#1c7ed6', '#8977fe', '#d6336c', '#e8e8e8'];

async function processImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 400;
    const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#26262c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) * .25, width, height);
    return canvas.toDataURL('image/jpeg', .85);
  } catch {
    throw new Error('Не удалось прочитать изображение.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
