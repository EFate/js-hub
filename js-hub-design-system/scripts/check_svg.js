const fs=require('fs');
const svg=fs.readFileSync(process.argv[2],'utf8');
// 收集所有 rect（节点）与 text，按 y 归组，估算是否溢出
// rx 兼容 8/10/12 等取值；同时抓 .layer 矩形做「节点在层内」兜底
const rects=[...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="(\d+)"/g)]
  .map(m=>({x:+m[1],y:+m[2],w:+m[3],h:+m[4]}));
const texts=[...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"([^>]*)>([^<]*)<\/text>/g)]
  .map(m=>({x:+m[1],y:+m[2],attrs:m[3],s:m[4]}));
function width(s,size){
  let w=0;
  for(const ch of s){
    const c=ch.codePointAt(0);
    if(c>=0x2e80) w+=size;            // CJK 全角
    else if(ch===' ') w+=size*0.28;
    else w+=size*0.55;
  }
  return w;
}
let bad=0;
for(const t of texts){
  if(!/text-anchor="middle"/.test(t.attrs)) continue;
  const fm=/font-size="([\d.]+)"/.exec(t.attrs);
  const cls=/class="(nt|nd|lg)/.exec(t.attrs);
  let size = fm? +fm[1] : (cls? (cls[1]==='nt'?12.5:cls[1]==='nd'?10.5:11) : 18);
  const w=width(t.s,size);
  const host=rects.filter(r=>t.x>=r.x && t.x<=r.x+r.w && t.y>=r.y && t.y<=r.y+r.h)
    .sort((a,b)=>(a.w*a.h)-(b.w*b.h))[0];   // 取最小包含矩形（节点，非层）
  if(host){
    const avail=host.w-8;
    if(w>avail){ bad++; console.log(`溢出? "${t.s}" 需${w.toFixed(0)}px 可用${avail}px`); }
  } else {
    // 非节点内文字（标题/层名），检查是否越出画布
    if(t.x-w/2<0||t.x+w/2>680){ bad++; console.log(`越界? "${t.s}"`);}
  }
}
console.log(bad?`❌ ${bad} 处可能溢出`:'✅ 无文字溢出');
