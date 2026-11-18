import { useEffect, useRef, useState } from "react";

type Action = "vision" | "ocr" | "ask" | "obstacles" | "currency" | "product" | "colors" | "people" | "place" | "simplify" | "explain" | "chat";
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: any) => void) | null; onerror: (() => void) | null;
  onend: (() => void) | null; start: () => void; stop: () => void;
};
declare global { interface Window { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike; } }

type Dialect = "egy" | "msa";
type Source = { title: string; url?: string };
type AIResult = { answer: string; provider?: string; translated?: boolean; sources?: Source[] };

async function askAI(action: Action, payload: { text?: string; image?: string; dialect?: Dialect; web?: boolean }): Promise<AIResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch("/api/assistant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }), signal: controller.signal
    });
    let data: any = null;
    try { data = await response.json(); } catch { /* الخادم رد بغير JSON */ }
    if (!response.ok) {
      const fallback = response.status === 413 ? "حجم الصورة كبير جدًا."
        : response.status === 504 ? "الخدمة تأخرت في الرد. حاول مرة أخرى." : "حدث خطأ غير متوقع.";
      throw new Error(data?.error || fallback);
    }
    return { answer: data.answer as string, provider: data.provider, translated: data.translated, sources: data.sources };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw new Error("الخدمة تأخرت في الرد. تحقق من الاتصال وحاول مرة أخرى.");
    throw e;
  } finally { window.clearTimeout(timer); }
}

export default function App() {
  const [font, setFont] = useState(17);
  const [contrast, setContrast] = useState(false);
  const [tab, setTab] = useState("home");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [chat, setChat] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechText, setSpeechText] = useState("");
  const [notice, setNotice] = useState("");
  const [visionMode, setVisionMode] = useState<Action>("vision");
  const [visionQuestion, setVisionQuestion] = useState("");
  const [liveMode, setLiveMode] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [lowData, setLowData] = useState(false);
  const [dialect, setDialect] = useState<Dialect>("egy");
  const [useWeb, setUseWeb] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const busyRef = useRef(false);
  const failRef = useRef(0);
  const runVisionRef = useRef<(action: Action, silent?: boolean) => Promise<void>>(async () => {});
  const lastLiveSpeechRef = useRef("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => setNotice("تعذر تشغيل معاينة الكاميرا."));
    }
  }, [cameraOn]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    recognitionRef.current?.stop();
  }, []);

  useEffect(() => {
    if (!liveMode || !cameraOn) return;
    failRef.current = 0;
    const timer = window.setInterval(() => { void runVisionRef.current("obstacles", true); }, lowData ? 12000 : 6500);
    return () => window.clearInterval(timer);
  }, [liveMode, cameraOn, lowData]);

  useEffect(() => {
    if (tab !== "vision" && streamRef.current) { setLiveMode(false); stopCamera(); }
    setResult(""); setSources([]);
  }, [tab]);

  function speak(text: string) {
    if (!("speechSynthesis" in window)) { setNotice("متصفحك لا يدعم القراءة الصوتية."); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const want = dialect === "egy" ? "ar-eg" : "ar-sa";
    const voice = voices.find(v => v.lang.toLowerCase() === want) || voices.find(v => v.lang.toLowerCase().startsWith("ar"));
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = dialect === "egy" ? "ar-EG" : "ar-SA";
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
  }

  async function startCamera() {
    setNotice("");
    if (!navigator.mediaDevices?.getUserMedia) { setNotice("الكاميرا تحتاج متصفحًا حديثًا واتصال HTTPS."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      setCameraOn(true);
    } catch { setNotice("لم نتمكن من فتح الكاميرا. تأكد من السماح بإذن الكاميرا."); }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null; setCameraOn(false);
  }
  function captureImage(): Promise<string> {
    return new Promise((resolve, reject) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return reject(new Error("انتظر حتى تظهر صورة الكاميرا."));
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1280 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("تعذر تجهيز الصورة."));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.78));
    });
  }
  async function runVision(action: Action, silent = false) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    if (!silent) { setNotice(""); setResult(""); }
    try {
      const image = await captureImage();
      const { answer, translated } = await askAI(action, { image, text: action === "ask" ? visionQuestion : undefined, dialect });
      failRef.current = 0;
      setResult(answer);
      if (translated === false) setNotice("وصلت النتيجة بالإنجليزية لأن الترجمة تعذرت. أضف GEMINI_API_KEY لنتائج عربية كاملة.");
      if (autoSpeak && (action === "obstacles" || action === "vision") && (!silent || answer !== lastLiveSpeechRef.current)) { speak(answer); lastLiveSpeechRef.current = answer; }
    } catch (e) {
      if (!silent) setNotice(e instanceof Error ? e.message : "حدث خطأ.");
      else {
        // في الرؤية المستمرة لا نترك المستخدم الكفيف بدون علم لو توقف التحليل
        failRef.current += 1;
        if (failRef.current === 3) {
          const warning = "تعذر تحليل الصورة عدة مرات. تحقق من الاتصال أو أوقف الرؤية المستمرة.";
          setNotice(warning); if (autoSpeak) speak(warning);
        }
      }
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  runVisionRef.current = runVision;
  async function runText(action: "simplify" | "explain" | "chat") {
    if (!message.trim()) { setNotice("اكتب النص أو السؤال أولًا."); return; }
    setBusy(true); setNotice(""); setResult(""); setSources([]);
    try {
      const { answer, sources: found } = await askAI(action, { text: message.trim(), dialect, web: action === "chat" && useWeb });
      setResult(answer); setSources(found || []);
      if (action === "chat") setChat(message.trim());
    }
    catch (e) { setNotice(e instanceof Error ? e.message : "حدث خطأ."); }
    finally { setBusy(false); }
  }
  function startListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { setNotice("تحويل الكلام إلى نص غير مدعوم في هذا المتصفح. جرّب Chrome."); return; }
    const recognition = new Recognition();
    recognition.lang = "ar-EG"; recognition.continuous = true; recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      let finalText = "";
      for (let i = 0; i < event.results.length; i++) finalText += event.results[i][0].transcript;
      setSpeechText(finalText);
    };
    recognition.onerror = () => { setNotice("تعذر استخدام الميكروفون. راجع الإذن وإعدادات المتصفح."); setListening(false); };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try { recognition.start(); setListening(true); setNotice("استمع سند الآن. اضغط إيقاف عند الانتهاء."); }
    catch { setNotice("تعذر بدء التعرف على الكلام."); }
  }
  function stopListening() { recognitionRef.current?.stop(); setListening(false); }
  function runVoiceCommand() {
    const command = speechText.trim().toLowerCase();
    if (!command) { setNotice("سجّل أمرًا صوتيًا أولًا."); return; }
    if (command.includes("الكاميرا") || command.includes("افتح")) { setTab("vision"); setNotice("افتح قسم عين سند ثم اسمح للكاميرا."); }
    else if (command.includes("تعلم") || command.includes("شرح")) { setTab("learning"); setMessage(speechText); setNotice("تم وضع كلامك في خانة الشرح."); }
    else { setTab("chat"); setMessage(speechText); setNotice("تم وضع كلامك في خانة المساعد."); }
  }

  const nav = [
    ["home", "الرئيسية", "⌂"], ["vision", "عين سند", "◉"], ["hearing", "السمعية", "◖"],
    ["motor", "الحركية", "✦"], ["learning", "التعلّم", "▤"], ["chat", "المساعد", "✧"]
  ];
  return <div className={contrast ? "app high-contrast" : "app"} style={{ fontSize: `${font}px` }}>
    <header className="topbar">
      <a className="brand" href="#home" onClick={() => setTab("home")}><span className="brand-mark">س</span><span><b>SANAD AI</b><small>سند · التقنية للجميع</small></span></a>
      <div className="access-tools">
        <button className="small-btn" onClick={() => setFont(v => Math.max(14, v - 1))} aria-label="تصغير الخط">A−</button>
        <button className="small-btn" onClick={() => setFont(v => Math.min(24, v + 1))} aria-label="تكبير الخط">A+</button>
        <button className="small-btn" onClick={() => setContrast(v => !v)} aria-pressed={contrast}>تباين</button>
      </div>
    </header>
    <div className="layout">
      <aside className="sidebar"><div className="side-label">القائمة الرئيسية</div>{nav.map(([id, label, symbol]) =>
        <button key={id} className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => { setTab(id); setNotice(""); }}>
          <span className="nav-icon" aria-hidden="true">{symbol}</span>{label}
        </button>)}
        <div className="side-note"><span>✦</span><b>سند معك</b><p>أدوات مساعدة مصممة لتكون أقرب وأسهل.</p></div>
      </aside>
      <main className="main" id="main">
        {tab === "home" && <><section className="hero">
          <div className="hero-copy"><span className="eyebrow">مساعدك الرقمي الميسّر</span><h1>أهلًا بك في <em>سند</em></h1>
            <p>مجموعة أدوات ذكية تساعدك على الفهم والتواصل والوصول للمعلومات بطريقة تناسب احتياجاتك.</p>
            <button className="primary" onClick={() => setTab("vision")}>ابدأ الاستخدام <span>←</span></button></div>
          <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one"></div><div className="orbit orbit-two"></div><div className="hero-core">س</div><span className="float-tag tag-one">ذكاء اصطناعي</span><span className="float-tag tag-two">إتاحة للجميع</span></div>
        </section>
        <div className="section-heading"><div><span className="eyebrow">خدمات سند</span><h2>اختر الأداة المناسبة</h2></div><span className="muted">كل الأدوات في مكان واحد</span></div>
        <div className="service-grid">
          <Service icon="◉" title="عين سند" desc="وصف الصور والمشاهد وقراءة النصوص بالكاميرا." onClick={() => setTab("vision")} />
          <Service icon="◖" title="مساعد التواصل" desc="حوّل الكلام المسموع إلى نص ظاهر على الشاشة." onClick={() => setTab("hearing")} />
          <Service icon="✦" title="التحكم الميسّر" desc="أوامر صوتية واختصارات وأزرار واضحة." onClick={() => setTab("motor")} />
          <Service icon="▤" title="مساعد التعلّم" desc="تبسيط النصوص وشرحها بطريقة منظمة." onClick={() => setTab("learning")} />
          <Service icon="✧" title="اسأل سند" desc="اكتب سؤالك واحصل على إجابة باللغة العربية." onClick={() => setTab("chat")} />
        </div>
        <div className="info-strip"><span>ⓘ</span><p>بعض الميزات تحتاج إذن الكاميرا أو الميكروفون، كما تحتاج خدمات الذكاء الاصطناعي إلى مفتاح API على الخادم (يكفي مفتاح Gemini المجاني).</p></div>
        </>}
        {tab === "vision" && <Page title="عين سند" subtitle="مساعد بصري ذكي لفهم المشاهد وقراءة ما حولك." icon="◉">
          <div className="vision-layout">
            <div className="camera-column">
              <div className="camera-box">{cameraOn ? <video ref={videoRef} autoPlay muted playsInline /> : <div className="camera-placeholder"><span>◉</span><b>معاينة الكاميرا</b><small>لن تعمل الكاميرا إلا بعد موافقتك</small></div>}</div>
              <div className="button-row camera-controls">{!cameraOn ? <button className="primary" onClick={startCamera}>تشغيل الكاميرا</button> : <button className="danger-btn" onClick={() => { setLiveMode(false); stopCamera(); }}>إيقاف الكاميرا فورًا</button>}
                <button className={liveMode ? "danger-btn" : "secondary"} disabled={!cameraOn} onClick={() => setLiveMode(v => !v)}>{liveMode ? "إيقاف الرؤية المستمرة" : "بدء الرؤية المستمرة"}</button></div>
              <div className="vision-settings"><label><input type="checkbox" checked={autoSpeak} onChange={e => setAutoSpeak(e.target.checked)} /> قراءة النتائج صوتيًا</label><label><input type="checkbox" checked={lowData} onChange={e => setLowData(e.target.checked)} /> توفير الإنترنت (تحليل أبطأ)</label>
                <label>لهجة الوصف <select value={dialect} onChange={e => setDialect(e.target.value as Dialect)}><option value="egy">مصري بسيط</option><option value="msa">فصحى مبسطة</option></select></label></div>
              <div className="status-line" role="status">{liveMode ? "● الرؤية المستمرة تعمل — لا تستخدمها بدل العصا البيضاء أو مرافق الحركة" : cameraOn ? "الكاميرا جاهزة للتحليل عند الطلب" : "الكاميرا متوقفة"}</div>
            </div>
            <div className="vision-tools">
              <h3>اختر ما تريد من عين سند</h3>
              <div className="vision-grid">
                {[
                  ["vision", "◉", "افهم المكان"], ["ask", "؟", "اسأل عين سند"], ["obstacles", "⌁", "افحص العوائق"],
                  ["ocr", "▤", "اقرأ النصوص"], ["currency", "＄", "اعرف العملة"], ["product", "▣", "افحص المنتج"],
                  ["colors", "◐", "اعرف الألوان"], ["people", "♙", "صف الأشخاص"], ["place", "⌖", "افهم المكان العام"]
                ].map(([action, icon, label]) => <button key={action} className={`vision-mode ${visionMode === action ? "selected" : ""}`} onClick={() => setVisionMode(action as Action)} aria-pressed={visionMode === action}><span aria-hidden="true">{icon}</span>{label}</button>)}
              </div>
              {visionMode === "ask" && <label className="question-label">اكتب سؤالك عن المشهد<textarea className="text-input question-input" value={visionQuestion} onChange={e => setVisionQuestion(e.target.value)} placeholder="مثال: أين الكوب بالنسبة للهاتف؟" /></label>}
              <button className="primary wide-btn" disabled={!cameraOn || busy || (visionMode === "ask" && !visionQuestion.trim())} onClick={() => runVision(visionMode)}>حلّل الصورة الآن</button>
              <p className="microcopy">يُرسل إطار واحد فقط عند الطلب. الرؤية المستمرة تلتقط إطارًا دوريًا أثناء تفعيلها ويمكن إيقافها في أي وقت.</p>
            </div>
          </div>
          <p className="safety-note">تنبيه سلامة مهم: نتائج الكاميرا قد تكون خاطئة أو متأخرة. لا تعتمد على عين سند لتجنب الاصطدام أو عبور الشارع أو صعود السلالم. استخدم وسائل الحركة المساعدة المعتادة.</p>
          <Output busy={busy} notice={notice} result={result} speak={speak} />
        </Page>}
        {tab === "hearing" && <Page title="مساعد التواصل" subtitle="حوّل الكلام القريب منك إلى نص على الشاشة." icon="◖">
          <div className="feature-card"><div className="mic-icon">◖</div><h3>تحويل الكلام إلى نص</h3><p>اضغط بدء الاستماع واسمح للمتصفح باستخدام الميكروفون.</p>
            <div className="button-row">{!listening ? <button className="primary" onClick={startListening}>بدء الاستماع</button> : <button className="secondary" onClick={stopListening}>إيقاف الاستماع</button>}
              <button className="secondary" onClick={() => setSpeechText("")}>مسح النص</button></div>
            <div className="transcript" aria-live="polite">{speechText || "سيظهر الكلام هنا…"}</div>
          </div>
          <p className="safety-note">تعتمد الدقة وتوفر الخدمة على المتصفح واللغة والضوضاء المحيطة. قد لا تعمل دون اتصال بالإنترنت.</p>
          {notice && <p className="notice">{notice}</p>}
        </Page>}
        {tab === "motor" && <Page title="التحكم الميسّر" subtitle="طرق أسهل للتنقل والتفاعل مع أدوات سند." icon="✦">
          <div className="service-grid two">
            <div className="feature-card"><h3>التحكم بالصوت</h3><p>استخدم الكلام لإدخال طلبك ثم اختر الإجراء المناسب.</p><button className="primary" onClick={startListening}>إملاء صوتي</button></div>
            <div className="feature-card"><h3>إعدادات الواجهة</h3><p>كبّر الخط أو فعّل التباين العالي من أعلى الصفحة.</p><div className="button-row"><button className="secondary" onClick={() => setFont(v => Math.min(24, v + 1))}>تكبير الخط</button><button className="secondary" onClick={() => setContrast(v => !v)}>تغيير التباين</button></div></div>
          </div>
          <div className="feature-card"><h3>أوامر صوتية مبسطة</h3><p>قل مثلًا: «افتح الكاميرا» أو «اشرح لي هذا» أو «اسأل سند».</p>
            <div className="transcript">{speechText || "النص الصوتي سيظهر هنا…"}</div>
            <div className="button-row"><button className="primary" onClick={runVoiceCommand}>تنفيذ الأمر المقترح</button><button className="secondary" onClick={() => setTab("hearing")}>فتح أداة الاستماع</button></div>
          </div>
          {notice && <p className="notice">{notice}</p>}
          <p className="safety-note">الأوامر الصوتية تنقلك داخل الموقع فقط، ولا تتحكم في الهاتف أو التطبيقات الأخرى.</p>
        </Page>}
        {tab === "learning" && <Page title="مساعد التعلّم" subtitle="حوّل النصوص الصعبة إلى شرح أوضح وأسهل." icon="▤">
          <textarea className="text-input large" value={message} onChange={e => setMessage(e.target.value)} placeholder="الصق النص أو اكتب الموضوع الذي تريد فهمه…" />
          <div className="button-row"><button className="primary" disabled={busy} onClick={() => runText("simplify")}>بسّط النص</button><button className="secondary" disabled={busy} onClick={() => runText("explain")}>اشرح خطوة بخطوة</button></div>
          <Output busy={busy} notice={notice} result={result} speak={speak} />
        </Page>}
        {tab === "chat" && <Page title="اسأل سند" subtitle="اكتب سؤالك وسأحاول مساعدتك باللغة العربية." icon="✧">
          {chat && <div className="chat-bubble user-bubble">{chat}</div>}
          <textarea className="text-input" value={message} onChange={e => setMessage(e.target.value)} placeholder="اكتب سؤالك هنا…" />
          <div className="vision-settings"><label><input type="checkbox" checked={useWeb} onChange={e => setUseWeb(e.target.checked)} /> استعن بالإنترنت مجانًا (ويكيبيديا العربية + DuckDuckGo)</label>
            <label>اللهجة <select value={dialect} onChange={e => setDialect(e.target.value as Dialect)}><option value="egy">مصري بسيط</option><option value="msa">فصحى مبسطة</option></select></label></div>
          <button className="primary" disabled={busy} onClick={() => runText("chat")}>إرسال السؤال</button>
          <Output busy={busy} notice={notice} result={result} speak={speak} sources={sources} />
        </Page>}
        <footer className="footer"><span>© SANAD AI</span><span>التقنية للجميع · نسخة تجريبية</span></footer>
      </main>
    </div>
  </div>;
}

function Service({ icon, title, desc, onClick }: { icon: string; title: string; desc: string; onClick: () => void }) {
  return <button className="service-card" onClick={onClick}><span className="service-icon" aria-hidden="true">{icon}</span><span className="service-title">{title}</span><span className="service-desc">{desc}</span><span className="card-arrow">←</span></button>;
}
function Page({ title, subtitle, icon, children }: { title: string; subtitle: string; icon: string; children: React.ReactNode }) {
  return <><div className="page-title"><span className="page-icon" aria-hidden="true">{icon}</span><div><h1>{title}</h1><p>{subtitle}</p></div></div><section className="work-panel">{children}</section></>;
}
function Output({ busy, notice, result, speak, sources = [] }: { busy: boolean; notice: string; result: string; speak: (text: string) => void; sources?: Source[] }) {
  return <>{busy && <div className="loading" role="status">سند يعمل على طلبك…</div>}{notice && <div className="notice" role="alert">{notice}</div>}{result && <div className="result" aria-live="polite"><div className="result-head"><b>نتيجة سند</b><button className="small-btn" onClick={() => speak(result)}>استمع للنتيجة</button></div><p>{result}</p>{sources.length > 0 && <div className="sources"><b>المصادر:</b><ul>{sources.map((s, i) => <li key={i}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</li>)}</ul></div>}</div>}</>;
}