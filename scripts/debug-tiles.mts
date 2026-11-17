/* eslint-disable no-console, node/prefer-global/buffer */
import cvImport from "@techstark/opencv-js";
import sharp from "sharp";
const cv = await (cvImport.default ?? cvImport);
const W = 1280, H = 960, WORK_WIDTH = 640;
const INK_MAX = 100, TILE_MIN = 150;

async function makeFrame(boardSide) {
  const frame = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { frame[i*3]=96; frame[i*3+1]=96; frame[i*3+2]=96; }
  const bx=(W-boardSide)/2|0, by=(H-boardSide)/2|0, cell=boardSide/4;
  const tileInner=cell*0.86|0, pad=(cell-tileInner)/2|0;
  for (let r=0;r<4;r++) for (let c=0;c<4;c++) {
    const cx=bx+c*cell+pad, cy=by+r*cell+pad;
    for (let y=cy;y<cy+tileInner;y++) for (let x=cx;x<cx+tileInner;x++) {
      const o=(y*W+x)*3; frame[o]=250; frame[o+1]=248; frame[o+2]=244;
    }
    const lx=cx+tileInner*0.42|0, ly=cy+tileInner*0.28|0;
    const lw=Math.max(2,tileInner*0.12|0), lh=tileInner*0.44|0;
    for (let y=ly;y<ly+lh;y++) for (let x=lx;x<lx+lw;x++) {
      const o=(y*W+x)*3; frame[o]=15; frame[o+1]=15; frame[o+2]=15;
    }
  }
  return sharp(frame,{raw:{width:W,height:H,channels:3}}).png().toBuffer();
}

async function diag(boardSide) {
  console.log(`\n=== board ${boardSide}px ===`);
  const png = await makeFrame(boardSide);
  const scale = WORK_WIDTH / W;
  const workH = Math.round(H*scale)&~1;
  const { data } = await sharp(png).resize(WORK_WIDTH, workH).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const src = cv.matFromArray(workH, WORK_WIDTH, cv.CV_8UC3, new Uint8Array(data.buffer, data.byteOffset, data.length));
  const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const bright = new cv.Mat(); cv.threshold(gray, bright, TILE_MIN, 255, cv.THRESH_BINARY);
  const closeK = Math.max(3, Math.round(Math.min(WORK_WIDTH, workH) * 0.03) | 1);
  console.log(`closeK=${closeK}`);
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeK, closeK));
  const closed = new cv.Mat(); cv.morphologyEx(bright, closed, cv.MORPH_CLOSE, k);
  const contours = new cv.MatVector(); const hie = new cv.Mat();
  cv.findContours(closed, contours, hie, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const total = WORK_WIDTH * workH;
  console.log(`contours=${contours.size()} total=${total}`);
  let bestArea=0, bestPts=null;
  for (let i=0;i<contours.size();i++) {
    const cnt=contours.get(i);
    const area=cv.contourArea(cnt);
    if (area<total*0.02){cnt.delete();continue;}
    const hull=new cv.Mat(); cv.convexHull(cnt,hull,false,true); cnt.delete();
    const peri=cv.arcLength(hull,true);
    const quad=new cv.Mat(); cv.approxPolyDP(hull,quad,0.01*peri,true); hull.delete();
    console.log(` cnt${i}: area=${area.toFixed(0)} (${(100*area/total).toFixed(1)}%) quad.rows=${quad.rows}`);
    if (quad.rows===4 && area>bestArea) {
      const d=quad.data32S;
      const pts=[{x:d[0],y:d[1]},{x:d[2],y:d[3]},{x:d[4],y:d[5]},{x:d[6],y:d[7]}];
      pts.sort((a,b)=>a.y-b.y);
      const top=pts.slice(0,2).sort((a,b)=>a.x-b.x);
      const bottom=pts.slice(2,4).sort((a,b)=>a.x-b.x);
      const ordered=[top[0],top[1],bottom[1],bottom[0]];
      const s=[Math.hypot(ordered[1].x-ordered[0].x,ordered[1].y-ordered[0].y),
               Math.hypot(ordered[3].x-ordered[0].x,ordered[3].y-ordered[0].y),
               Math.hypot(ordered[2].x-ordered[1].x,ordered[2].y-ordered[1].y),
               Math.hypot(ordered[2].x-ordered[3].x,ordered[2].y-ordered[3].y)];
      console.log(`   sides: ${s.map(x=>x.toFixed(0)).join(",")} ratio=${(Math.max(...s)/Math.min(...s)).toFixed(2)}`);
      if (Math.max(...s) <= Math.min(...s)*2 && Math.max(...s)>=50) { bestArea=area; bestPts=ordered; }
    }
    quad.delete();
  }
  console.log(` bestArea=${bestArea.toFixed(0)} bestPts=${bestPts?"yes":"no"}`);
  if (bestPts) {
    console.log(` bestPts quad: ${JSON.stringify(bestPts)}`);
  if (bestPts) {
    const xs=bestPts.map(p=>p.x), ys=bestPts.map(p=>p.y);
    const x0=Math.max(0,Math.floor(Math.min(...xs))), x1=Math.min(WORK_WIDTH,Math.ceil(Math.max(...xs)));
    const y0=Math.max(0,Math.floor(Math.min(...ys))), y1=Math.min(workH,Math.ceil(Math.max(...ys)));
    const roiRect=new cv.Rect(x0,y0,x1-x0,y1-y0);
    const roi=gray.roi(roiRect);
    const ink=new cv.Mat(); cv.threshold(roi,ink,INK_MAX,255,cv.THRESH_BINARY_INV);
    roi.delete(); roiRect.delete?.();
    const il=new cv.Mat(), istat=new cv.Mat(), icen=new cv.Mat();
    const icnt=cv.connectedComponentsWithStats(ink,il,istat,icen,8,cv.CV_32S);
    ink.delete(); il.delete(); icen.delete();
    const quadArea=(x1-x0)*(y1-y0);
    let lets=0;
    for (let i=1;i<icnt;i++){
      const a=istat.intPtr(i,4)[0], w=istat.intPtr(i,2)[0], h=istat.intPtr(i,3)[0];
      if (a<quadArea*0.0005||a>quadArea*0.02) continue;
      if (w<2||h<2||w>(x1-x0)/4||h>(y1-y0)/4) continue;
      const ar=Math.max(w,h)/Math.max(1,Math.min(w,h));
      if (ar>4) continue;
      lets++;
    }
    console.log(` ink letters=${lets} (quadArea=${quadArea})`);
    istat.delete();
  }
  src.delete(); gray.delete(); bright.delete(); closed.delete(); k.delete(); contours.delete(); hie.delete();
}

await diag(140);
await diag(940);
await diag(700);
