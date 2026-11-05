import {readdir, mkdir, copyFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

// ios init creates an asset catalog: explicitly replace it before Xcode compiles.
const source = path.resolve('src-tauri/icons/ios');
async function catalogs(dir) {
  const result = [];
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir,entry.name);
    if (entry.name === 'AppIcon.appiconset') result.push(full);
    else result.push(...await catalogs(full));
  }
  return result;
}
const destinations = await catalogs(path.resolve('src-tauri/gen/apple'));
if (!destinations.length) throw new Error('iOS AppIcon asset catalog not found');
const images = [];
for (const filename of await readdir(source)) {
  const match = /^AppIcon-(\d+(?:\.\d+)?)x\1@(\d)x(-1)?\.png$/.exec(filename);
  if (filename === 'AppIcon-512@2x.png') images.push({filename,idiom:'ios-marketing',size:'1024x1024',scale:'1x'});
  else if (match) {
    const [,size,scale,tablet] = match;
    images.push({filename,idiom:tablet || scale==='1' || Number(size)>=76 ? 'ipad':'iphone',size:`${size}x${size}`,scale:`${scale}x`});
  }
}
if (images.length !== 18) throw new Error(`Incomplete KitChat icon set: ${images.length}`);
for (const dest of destinations) {
  await mkdir(dest,{recursive:true});
  for (const image of images) await copyFile(path.join(source,image.filename),path.join(dest,image.filename));
  await writeFile(path.join(dest,'Contents.json'),JSON.stringify({images,info:{version:1,author:'xcode'}},null,2));
}
console.log(`Installed KitChat icons in ${destinations.length} iOS asset catalog(s)`);
