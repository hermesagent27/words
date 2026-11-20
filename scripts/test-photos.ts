import { useOcr } from "../app/composables/useOcr";
import { createBoardConsensus } from "../app/utils/consensus";
import { solveBoard, Trie } from "../app/utils/solver";

const photos = [
  "close-down",
  "close-left",
  "close-right",
  "close-up",
  "far-down",
  "far-left",
  "far-right",
  "far-up",
];
const expected = ["WORU", "RUNT", "OORV", "TPEG"];

/** Run in an authenticated development browser; see README for the command. */
export async function testPhotos() {
  const response = await fetch("/dict/words.txt");
  if (!response.ok)
    throw new Error(`Could not load dictionary: HTTP ${response.status}`);
  const trie = new Trie();
  for (const word of (await response.text()).split(/\r?\n/)) {
    if (word.trim().length >= 3)
      trie.insert(word.trim());
  }
  const ocr = useOcr();
  const results: Array<{ photo: string; millisecondsPerScan: number }> = [];
  for (const photo of photos) {
    const image = new Image();
    image.src = `/${photo}.JPG`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Could not create photo canvas");
    context.drawImage(image, 0, 0);
    const consensus = createBoardConsensus();
    const started = performance.now();
    let board;
    for (let scan = 0; scan < 2; scan++) {
      const result = await ocr.detectGrid(canvas);
      if (!result)
        throw new Error(`${photo}: ${ocr.error.value ?? "board not detected"}`);
      if (result.obstructed)
        throw new Error(`${photo}: unobstructed board was marked obstructed`);
      board = consensus.update(result.tiles);
    }
    if (!board)
      throw new Error(`${photo}: no scans completed`);
    const actual = board.map(row => row.map(tile => tile.letter || "?").join(""));
    if (actual.join("/") !== expected.join("/"))
      throw new Error(`${photo}: expected ${expected.join("/")}, got ${actual.join("/")}`);
    const best = solveBoard(board, trie)[0];
    if (best?.word !== "torpor")
      throw new Error(`${photo}: expected TORPOR, got ${best?.word ?? "no word"}`);
    results.push({ photo, millisecondsPerScan: Math.round((performance.now() - started) / 2) });
  }

  const synthetic = document.createElement("canvas");
  synthetic.width = 800;
  synthetic.height = 1000;
  const context = synthetic.getContext("2d");
  if (!context)
    throw new Error("Could not create synthetic board");
  context.fillStyle = "#2671aa";
  context.fillRect(0, 0, 800, 1000);
  if (await ocr.detectGrid(synthetic))
    throw new Error("A blank image was detected as a board");
  if (ocr.error.value)
    throw new Error(`Blank image scan failed: ${ocr.error.value}`);
  context.fillStyle = "#143755";
  context.fillRect(90, 240, 620, 620);
  const rows = ["QORU", "RUNT", "OORV", "TPEG"];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      context.fillStyle = "#eeeeeb";
      context.fillRect(100 + col * 150, 250 + row * 150, 140, 140);
      context.fillStyle = "#111";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.font = "bold 70px Arial";
      context.fillText(rows[row]![col]!, 170 + col * 150, 310 + row * 150);
      if (row === 0 && col === 0) {
        context.font = "bold 30px Arial";
        context.fillText("u", 205, 325);
      }
      context.beginPath();
      context.arc(170 + col * 150, 365 + row * 150, 4, 0, Math.PI * 2);
      context.fill();
    }
  }
  const syntheticResult = await ocr.detectGrid(synthetic);
  if (!syntheticResult || syntheticResult.obstructed || syntheticResult.tiles[0]?.[0]?.letter !== "Q")
    throw new Error(`Synthetic QU tile was not read as Q: ${ocr.error.value ?? "not detected"}`);
  const clearBoard = context.getImageData(0, 0, synthetic.width, synthetic.height);
  for (const color of ["#c68861", "#784b34", "#1f1f1f"]) {
    context.putImageData(clearBoard, 0, 0);
    context.fillStyle = color;
    context.beginPath();
    context.ellipse(170, 310, 35, 45, 0, 0, Math.PI * 2);
    context.fill();
    const result = await ocr.detectGrid(synthetic);
    if (!result)
      throw new Error(`Synthetic patch ${color}: ${ocr.error.value ?? "board not detected"}`);
    if (result.obstructed !== (color === "#1f1f1f"))
      throw new Error(`Synthetic patch ${color} had unexpected obstruction status`);
  }
  return results;
}
