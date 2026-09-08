const express=require("express");
const cookieParser=require("cookie-parser");
const multer=require("multer");
const path=require("path"),fs=require("fs"),crypto=require("crypto");
const {Pool}=require("pg");

const app=express();
const PORT=process.env.PORT||3000;
const DATA_DIR=process.env.UPLOAD_DIR||"/var/data/uploads";
fs.mkdirSync(DATA_DIR,{recursive:true});

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false
});
const upload=multer({
  storage:multer.diskStorage({
    destination:(req,file,cb)=>cb(null,DATA_DIR),
    filename:(req,file,cb)=>{
      const ext=path.extname(file.originalname).toLowerCase();
      cb(null,crypto.randomUUID()+ext);
    }
  }),
  limits:{fileSize:process.env.MAX_FILE_SIZE_MB?Number(process.env.MAX_FILE_SIZE_MB)*1024*1024:500*1024*1024},
  fileFilter:(req,file,cb)=>{
    const ok=/^(video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp))$/i.test(file.mimetype);
    cb(ok?null:new Error("Unsupported file type"),ok);
  }
});
app.use(express.json({limit:"5mb"}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,"public")));
app.use("/uploads",express.static(DATA_DIR,{maxAge:"7d"}));

async function q(sql,p=[]){return pool.query(sql,p)}
function id(){return crypto.randomUUID()}
function ident(req,res){
  let x=req.cookies.lt_identity;
  if(!x){x=id();res.cookie("lt_identity",x,{httpOnly:true,sameSite:"lax",maxAge:31536000000})}
  return x
}
function isOwner(req){return req.cookies.lt_owner==="1"}

async function init(){
 await q(`CREATE TABLE IF NOT EXISTS profiles(
 id UUID PRIMARY KEY, username TEXT NOT NULL, bio TEXT DEFAULT '', avatar_url TEXT DEFAULT '',
 created_at TIMESTAMPTZ DEFAULT now())`);
 await q(`CREATE TABLE IF NOT EXISTS channels(
 id UUID PRIMARY KEY, owner_profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
 name TEXT NOT NULL, description TEXT DEFAULT '', avatar_url TEXT DEFAULT '', banner_url TEXT DEFAULT '',
 created_at TIMESTAMPTZ DEFAULT now())`);
 await q(`CREATE TABLE IF NOT EXISTS videos(
 id UUID PRIMARY KEY, channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
 title TEXT NOT NULL, description TEXT DEFAULT '', thumbnail_url TEXT DEFAULT '', video_url TEXT NOT NULL,
 views BIGINT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())`);
 await q(`CREATE TABLE IF NOT EXISTS subscriptions(
 id BIGSERIAL PRIMARY KEY, subscriber_key TEXT NOT NULL,
 channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(subscriber_key,channel_id))`);
 await q(`CREATE INDEX IF NOT EXISTS videos_created_idx ON videos(created_at DESC)`);
}

app.get("/api/home",async(req,res)=>{
 try{
  const v=await q(`SELECT v.*,c.name channel_name,c.avatar_url channel_avatar,
   (SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) subscribers
   FROM videos v JOIN channels c ON c.id=v.channel_id ORDER BY v.created_at DESC LIMIT 100`);
  const c=await q(`SELECT c.*,(SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) subscribers
   FROM channels c ORDER BY c.created_at DESC LIMIT 50`);
  res.json({videos:v.rows,channels:c.rows});
 }catch(e){res.status(500).json({error:"Database error"})}
});

app.get("/api/profile",async(req,res)=>{const r=await q("SELECT * FROM profiles WHERE id=$1",[ident(req,res)]);res.json(r.rows[0]||null)});
app.post("/api/profile",async(req,res)=>{
 const profile=ident(req,res),{username,bio="",avatar_url=""}=req.body;
 if(!username||username.trim().length<2)return res.status(400).json({error:"Вкажи ім'я"});
 const r=await q(`INSERT INTO profiles(id,username,bio,avatar_url) VALUES($1,$2,$3,$4)
 ON CONFLICT(id) DO UPDATE SET username=$2,bio=$3,avatar_url=$4 RETURNING *`,
 [profile,username.trim().slice(0,40),String(bio).slice(0,500),String(avatar_url).slice(0,1500)]);
 res.json(r.rows[0]);
});

app.post("/api/channel",async(req,res)=>{
 const p=ident(req,res),check=await q("SELECT id FROM profiles WHERE id=$1",[p]);
 if(!check.rows.length)return res.status(400).json({error:"Спочатку створи профіль"});
 const {name,description="",avatar_url="",banner_url=""}=req.body;
 if(!name)return res.status(400).json({error:"Потрібна назва"});
 const r=await q(`INSERT INTO channels(id,owner_profile_id,name,description,avatar_url,banner_url)
 VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
 [id(),p,String(name).slice(0,80),String(description).slice(0,1000),String(avatar_url).slice(0,1500),String(banner_url).slice(0,1500)]);
 res.json(r.rows[0]);
});

app.get("/api/channels/:id",async(req,res)=>{
 const c=await q(`SELECT c.*,(SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) subscribers
 FROM channels c WHERE c.id=$1`,[req.params.id]);
 if(!c.rows.length)return res.status(404).json({error:"Канал не знайдено"});
 const v=await q("SELECT * FROM videos WHERE channel_id=$1 ORDER BY created_at DESC",[req.params.id]);
 res.json({channel:c.rows[0],videos:v.rows});
});

app.get("/api/channels/:id/subscribed",async(req,res)=>{
 const r=await q("SELECT 1 FROM subscriptions WHERE subscriber_key=$1 AND channel_id=$2",[ident(req,res),req.params.id]);
 res.json({subscribed:!!r.rows.length});
});
app.post("/api/channels/:id/subscribe",async(req,res)=>{
 try{await q("INSERT INTO subscriptions(subscriber_key,channel_id) VALUES($1,$2)",[ident(req,res),req.params.id])}
 catch(e){if(e.code!=="23505")throw e}
 const r=await q("SELECT count(*) FROM subscriptions WHERE channel_id=$1",[req.params.id]);
 res.json({subscribed:true,subscribers:Number(r.rows[0].count)});
});
app.delete("/api/channels/:id/subscribe",async(req,res)=>{
 await q("DELETE FROM subscriptions WHERE subscriber_key=$1 AND channel_id=$2",[ident(req,res),req.params.id]);
 const r=await q("SELECT count(*) FROM subscriptions WHERE channel_id=$1",[req.params.id]);
 res.json({subscribed:false,subscribers:Number(r.rows[0].count)});
});

app.post("/api/channels/:id/videos",async(req,res)=>{
 const {title,description="",thumbnail_url="",video_url}=req.body;
 const c=await q("SELECT owner_profile_id FROM channels WHERE id=$1",[req.params.id]);
 if(!c.rows.length)return res.status(404).json({error:"Канал не знайдено"});
 if(c.rows[0].owner_profile_id!==ident(req,res))return res.status(403).json({error:"Тільки власник каналу"});
 if(!title||!video_url)return res.status(400).json({error:"Потрібні назва та відео"});
 const r=await q(`INSERT INTO videos(id,channel_id,title,description,thumbnail_url,video_url)
 VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
 [id(),req.params.id,String(title).slice(0,160),String(description).slice(0,5000),String(thumbnail_url).slice(0,1500),String(video_url).slice(0,2000)]);
 res.json(r.rows[0]);
});

app.post("/api/upload",upload.fields([{name:"video",maxCount:1},{name:"thumbnail",maxCount:1}]),async(req,res)=>{
 try{
  if(!req.files?.video?.[0])return res.status(400).json({error:"Вибери відео"});
  const c=await q("SELECT owner_profile_id FROM channels WHERE id=$1",[req.body.channel_id]);
  if(!c.rows.length)return res.status(404).json({error:"Канал не знайдено"});
  if(c.rows[0].owner_profile_id!==ident(req,res))return res.status(403).json({error:"Тільки власник каналу"});
  const video="/uploads/"+req.files.video[0].filename;
  const thumb=req.files.thumbnail?.[0]?"/uploads/"+req.files.thumbnail[0].filename:"";
  const r=await q(`INSERT INTO videos(id,channel_id,title,description,thumbnail_url,video_url)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
   [id(),req.body.channel_id,String(req.body.title||"Без назви").slice(0,160),
    String(req.body.description||"").slice(0,5000),thumb,video]);
  res.json(r.rows[0]);
 }catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/videos/:id",async(req,res)=>{
 const r=await q(`SELECT v.*,c.name channel_name,c.avatar_url channel_avatar
 FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=$1`,[req.params.id]);
 if(!r.rows.length)return res.status(404).json({error:"Відео не знайдено"});
 await q("UPDATE videos SET views=views+1 WHERE id=$1",[req.params.id]);
 r.rows[0].views=Number(r.rows[0].views)+1;
 res.json(r.rows[0]);
});

app.post("/api/owner/login",(req,res)=>{
 if(req.body.password && process.env.OWNER_PASSWORD && req.body.password===process.env.OWNER_PASSWORD){
  res.cookie("lt_owner","1",{httpOnly:true,sameSite:"lax",maxAge:86400000});return res.json({ok:true})
 }
 res.status(401).json({error:"Неправильний пароль"});
});
app.post("/api/owner/logout",(req,res)=>{res.clearCookie("lt_owner");res.json({ok:true})});
app.get("/api/owner/check",(req,res)=>res.json({owner:isOwner(req)}));
app.get("/api/owner/data",async(req,res)=>{
 if(!isOwner(req))return res.status(403).json({error:"Owner only"});
 const [v,c]=await Promise.all([
  q("SELECT v.*,c.name channel_name FROM videos v JOIN channels c ON c.id=v.channel_id ORDER BY v.created_at DESC"),
  q(`SELECT c.*,(SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) subscribers
  FROM channels c ORDER BY c.created_at DESC`)]);
 res.json({videos:v.rows,channels:c.rows});
});
function safeRemove(url){
 if(!url||!url.startsWith("/uploads/"))return;
 const p=path.join(DATA_DIR,path.basename(url));
 if(fs.existsSync(p))fs.unlinkSync(p);
}
app.delete("/api/owner/videos/:id",async(req,res)=>{
 if(!isOwner(req))return res.status(403).json({error:"Owner only"});
 const r=await q("SELECT video_url,thumbnail_url FROM videos WHERE id=$1",[req.params.id]);
 if(r.rows[0]){safeRemove(r.rows[0].video_url);safeRemove(r.rows[0].thumbnail_url)}
 await q("DELETE FROM videos WHERE id=$1",[req.params.id]);res.json({ok:true});
});
app.delete("/api/owner/channels/:id",async(req,res)=>{
 if(!isOwner(req))return res.status(403).json({error:"Owner only"});
 const v=await q("SELECT video_url,thumbnail_url FROM videos WHERE channel_id=$1",[req.params.id]);
 v.rows.forEach(x=>{safeRemove(x.video_url);safeRemove(x.thumbnail_url)});
 await q("DELETE FROM channels WHERE id=$1",[req.params.id]);res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
init().then(()=>app.listen(PORT,"0.0.0.0",()=>console.log("LimeTube started")))
.catch(e=>{console.error(e);process.exit(1)});
