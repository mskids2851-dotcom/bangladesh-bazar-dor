import React, { useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";
import { auth, db, ADMIN_EMAILS } from "./firebase";
import { CATEGORIES, DIVISIONS, DISTRICTS, UNITS } from "./data";

const CATEGORY_ICONS = {
  "kacha-bazar": "🥬",
  "electronics": "🔌",
  "grocery": "🛒",
  "fish-meat": "🐟",
  "fruits": "🍎",
};

const DIVISION_NAMES = Object.keys(DIVISIONS);
const votingInProgress = new Set();
const STALE_DAYS = 7;
const REPORT_REASONS = ["ভুল দাম", "ভুয়া তথ্য", "পুরোনো দাম", "Spam", "অন্য সমস্যা"];

function displayName(user) {
  if (!user) return "";
  return user.displayName || user.email.split("@")[0];
}

function ageDays(timestamp) {
  if (!timestamp || !timestamp.toDate) return 0;
  return (Date.now() - timestamp.toDate().getTime()) / (1000 * 60 * 60 * 24);
}

function timeAgo(timestamp) {
  if (!timestamp || !timestamp.toDate) return "";
  const diffMs = Date.now() - timestamp.toDate().getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "এইমাত্র";
  if (mins < 60) return `${mins} মিনিট আগে`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ঘণ্টা আগে`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} দিন আগে`;
  const months = Math.floor(days / 30);
  return `${months} মাস আগে`;
}

function mapLink(it) {
  if (it.locationLink) return it.locationLink;
  if (it.locationLat && it.locationLng) return `https://www.google.com/maps?q=${it.locationLat},${it.locationLng}`;
  return null;
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function sharePrice(it) {
  const text = `${it.productName} — ৳${it.price}/${it.unit} (${it.districtId}${it.upazila ? ", " + it.upazila : ""}) — বাংলাদেশ বাজার দর অ্যাপে দেখুন`;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (e) {}
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    alert("কপি হয়েছে, এখন যেকোনো জায়গায় পেস্ট করুন");
  }
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (e) {}
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    alert("রিপোর্ট কপি হয়েছে, এখন পেস্ট করুন");
  }
}

async function handleVote(user, itemId, type, onNeedLogin) {
  if (!user) { onNeedLogin(); return; }
  const lockKey = `${itemId}_${user.uid}`;
  if (votingInProgress.has(lockKey)) return;
  votingInProgress.add(lockKey);
  const voteId = `${itemId}_${user.uid}`;
  const voteRef = doc(db, "votes", voteId);
  const priceRef = doc(db, "prices", itemId);
  try {
    const snap = await getDoc(voteRef);
    if (snap.exists()) {
      const prev = snap.data().type;
      if (prev === type) {
        await deleteDoc(voteRef);
        await updateDoc(priceRef, { [type === "up" ? "upvotes" : "downvotes"]: increment(-1) });
      } else {
        await setDoc(voteRef, { priceId: itemId, uid: user.uid, type, createdAt: serverTimestamp() });
        await updateDoc(priceRef, {
          [prev === "up" ? "upvotes" : "downvotes"]: increment(-1),
          [type === "up" ? "upvotes" : "downvotes"]: increment(1),
        });
      }
    } else {
      await setDoc(voteRef, { priceId: itemId, uid: user.uid, type, createdAt: serverTimestamp() });
      await updateDoc(priceRef, { [type === "up" ? "upvotes" : "downvotes"]: increment(1) });
    }
  } catch (err) {
  } finally {
    votingInProgress.delete(lockKey);
  }
}

async function toggleFavorite(user, productName, isFav, onNeedLogin) {
  if (!user) { onNeedLogin(); return; }
  const ref = doc(db, "favorites", user.uid);
  try {
    await setDoc(ref, {
      products: isFav ? arrayRemove(productName) : arrayUnion(productName),
    }, { merge: true });
  } catch (err) {}
}

async function reportPrice(user, item, reason, onNeedLogin) {
  if (!user) { onNeedLogin(); return; }
  try {
    await addDoc(collection(db, "reports"), {
      priceId: item.id,
      productName: item.productName,
      price: item.price,
      unit: item.unit,
      districtId: item.districtId,
      reason,
      reporterUid: user.uid,
      reporterEmail: user.email,
      status: "open",
      createdAt: serverTimestamp(),
    });
  } catch (err) {}
}

function useFavorites(user) {
  const [favorites, setFavorites] = useState([]);
  useEffect(() => {
    if (!user) { setFavorites([]); return; }
    const unsub = onSnapshot(doc(db, "favorites", user.uid), (snap) => {
      setFavorites(snap.exists() ? (snap.data().products || []) : []);
    });
    return unsub;
  }, [user]);
  return favorites;
}

function useLatestAnnouncement() {
  const [announcement, setAnnouncement] = useState(null);
  useEffect(() => {
    const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(1));
    const unsub = onSnapshot(q, (snap) => {
      setAnnouncement(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() });
    });
    return unsub;
  }, []);
  return announcement;
}

function reputationBadge(count) {
  if (count >= 20) return { label: "বিশ্বস্ত কনট্রিবিউটর", icon: "🏆" };
  if (count >= 5) return { label: "নিয়মিত কনট্রিবিউটর", icon: "⭐" };
  return { label: "নতুন কনট্রিবিউটর", icon: "🌱" };
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [screen, setScreen] = useState("home");
  const [pendingScreen, setPendingScreen] = useState("home");
  const [selectedItemId, setSelectedItemId] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const goProtected = (target) => {
    if (user) {
      setScreen(target);
    } else {
      setPendingScreen(target);
      setScreen("login");
    }
  };

  const openDetail = (id) => {
    setSelectedItemId(id);
    setScreen("detail");
  };

  const isAdmin = user && ADMIN_EMAILS.includes(user.email);

  if (authLoading) return <div className="app-shell"><div className="content">লোড হচ্ছে...</div></div>;

  return (
    <div className="app-shell">
      <TopBar screen={screen} onBack={() => setScreen("home")} />
      <div className="content">
        {screen === "home" && <HomeScreen user={user} onNeedLogin={() => goProtected("addPrice")} onOpenDetail={openDetail} />}
        {screen === "addPrice" && (
          user
            ? <AddPriceScreen user={user} onDone={() => setScreen("home")} />
            : <LoginScreen onSuccess={() => setScreen(pendingScreen)} />
        )}
        {screen === "profile" && (
          user
            ? <ProfileScreen user={user} onOpenDetail={openDetail} />
            : <LoginScreen onSuccess={() => setScreen(pendingScreen)} />
        )}
        {screen === "login" && <LoginScreen onSuccess={() => setScreen(pendingScreen)} />}
        {screen === "admin" && isAdmin && <AdminScreen />}
        {screen === "detail" && selectedItemId && (
          <DetailScreen itemId={selectedItemId} user={user} onNeedLogin={() => goProtected("detail")} />
        )}
      </div>
      <NavBar
        screen={screen}
        isAdmin={isAdmin}
        user={user}
        onHome={() => setScreen("home")}
        onAddPrice={() => goProtected("addPrice")}
        onProfile={() => goProtected("profile")}
        onAdmin={() => setScreen("admin")}
        onLogin={() => { setPendingScreen("home"); setScreen("login"); }}
        onLogout={() => { signOut(auth); setScreen("home"); }}
      />
    </div>
  );
}

function TopBar({ screen, onBack }) {
  const titles = {
    home: "বাংলাদেশ বাজার দর",
    addPrice: "দাম যোগ করুন",
    profile: "আমার তথ্য",
    admin: "এডমিন প্যানেল",
    login: "লগইন / অ্যাকাউন্ট",
    detail: "পণ্যের বিস্তারিত",
  };
  return (
    <div className="topbar">
      {screen !== "home" && (
        <button className="top-back" onClick={onBack}>← হোম</button>
      )}
      <h1>{titles[screen]}</h1>
      {screen === "home" && <div className="sub">সারা দেশের বাজার দর, এক জায়গায়</div>}
    </div>
  );
}

function NavBar({ screen, isAdmin, user, onHome, onAddPrice, onProfile, onAdmin, onLogin, onLogout }) {
  return (
    <div className="navbar">
      <button className={screen === "home" ? "active" : ""} onClick={onHome}><span className="navicon">🏠</span>হোম</button>
      <button className={screen === "addPrice" ? "active" : ""} onClick={onAddPrice}><span className="navicon">➕</span>দাম যোগ</button>
      <button className={screen === "profile" ? "active" : ""} onClick={onProfile}><span className="navicon">👤</span>আমার তথ্য</button>
      {isAdmin && (
        <button className={screen === "admin" ? "active" : ""} onClick={onAdmin}><span className="navicon">🛠️</span>এডমিন</button>
      )}
      {user
        ? <button onClick={onLogout}><span className="navicon">🚪</span>লগআউট</button>
        : <button className={screen === "login" ? "active" : ""} onClick={onLogin}><span className="navicon">🔑</span>লগইন</button>}
    </div>
  );
}

function LoginScreen({ onSuccess }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
      onSuccess();
    } catch (err) {
      setError(errorToBangla(err.code));
    }
    setLoading(false);
  };

  return (
    <div>
      <div className="empty" style={{ marginBottom: 4 }}>
        পণ্যের দাম যোগ করতে বা নিজের তথ্য দেখতে লগইন করুন
      </div>
      <form className="card" onSubmit={submit}>
        <label>ইমেইল</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <label>পাসওয়ার্ড</label>
        <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="কমপক্ষে ৬ অক্ষর" />
        {error && <div className="error-text">{error}</div>}
        <button className="primary" type="submit" disabled={loading}>
          {loading ? "অপেক্ষা করুন..." : mode === "login" ? "লগইন করুন" : "অ্যাকাউন্ট তৈরি করুন"}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login" ? "নতুন অ্যাকাউন্ট তৈরি করুন" : "আগে থেকে অ্যাকাউন্ট আছে? লগইন করুন"}
        </button>
      </form>
    </div>
  );
}

function errorToBangla(code) {
  const map = {
    "auth/invalid-email": "সঠিক ইমেইল দিন",
    "auth/email-already-in-use": "এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে",
    "auth/weak-password": "পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে",
    "auth/wrong-password": "পাসওয়ার্ড ভুল হয়েছে",
    "auth/user-not-found": "এই ইমেইলে কোনো অ্যাকাউন্ট নেই",
    "auth/invalid-credential": "ইমেইল বা পাসওয়ার্ড ভুল",
  };
  return map[code] || "কিছু একটা সমস্যা হয়েছে, আবার চেষ্টা করুন";
}

function HomeScreen({ user, onNeedLogin, onOpenDetail }) {
  const [allItems, setAllItems] = useState([]);
  const [dbError, setDbError] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [divisionId, setDivisionId] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [sortBy, setSortBy] = useState("new");
  const [onlyFav, setOnlyFav] = useState(false);
  const [myCoords, setMyCoords] = useState(null);
  const [locError, setLocError] = useState("");
  const favorites = useFavorites(user);
  const announcement = useLatestAnnouncement();

  useEffect(() => {
    const q = query(
      collection(db, "prices"),
      where("status", "==", "approved"),
      orderBy("createdAt", "desc"),
      limit(300)
    );
    const unsub = onSnapshot(q, (snap) => {
      setAllItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => setDbError(err.message));
    return unsub;
  }, []);

  const enableNearby = () => {
    if (!navigator.geolocation) {
      setLocError("এই ডিভাইসে লোকেশন সাপোর্ট নেই");
      return;
    }
    setLocError("লোকেশন খোঁজা হচ্ছে...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMyCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setSortBy("nearby");
        setLocError("");
      },
      () => setLocError("লোকেশন অনুমতি পাওয়া যায়নি"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const districtOptions = divisionId ? DIVISIONS[divisionId] : DISTRICTS;

  let filtered = allItems.filter((it) => {
    if (categoryId && it.categoryId !== categoryId) return false;
    if (districtId) {
      if (it.districtId !== districtId) return false;
    } else if (divisionId) {
      if (!DIVISIONS[divisionId].includes(it.districtId)) return false;
    }
    if (search.trim() && !it.productName.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (onlyFav && !favorites.includes(it.productName)) return false;
    return true;
  });

  filtered = filtered.map((it) => {
    if (myCoords && it.locationLat && it.locationLng) {
      return { ...it, _distance: distanceKm(myCoords.lat, myCoords.lng, it.locationLat, it.locationLng) };
    }
    return { ...it, _distance: null };
  });

  filtered = [...filtered].sort((a, b) => {
    if (sortBy === "priceLow") return a.price - b.price;
    if (sortBy === "priceHigh") return b.price - a.price;
    if (sortBy === "old") return (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0);
    if (sortBy === "nearby") {
      const da = a._distance === null ? Infinity : a._distance;
      const db_ = b._distance === null ? Infinity : b._distance;
      return da - db_;
    }
    return (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0);
  });

  return (
    <div>
      {announcement && (
        <div className="announcement-banner">📢 {announcement.message}</div>
      )}

      <div className="search-bar">
        <span className="search-icon">🔍</span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="পণ্যের নাম লিখে খুঁজুন, যেমন: আলু"
        />
      </div>

      <div className="chip-row">
        <button
          className={`chip ${categoryId === "" ? "active" : ""}`}
          onClick={() => setCategoryId("")}
        >
          <span className="chip-icon">🗂️</span>সব
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`chip ${categoryId === c.id ? "active" : ""}`}
            onClick={() => setCategoryId(categoryId === c.id ? "" : c.id)}
          >
            <span className="chip-icon">{CATEGORY_ICONS[c.id] || "🏷️"}</span>{c.name}
          </button>
        ))}
        {user && (
          <button
            className={`chip ${onlyFav ? "active" : ""}`}
            onClick={() => setOnlyFav(!onlyFav)}
          >
            <span className="chip-icon">❤️</span>প্রিয়
          </button>
        )}
        <button className={`chip ${sortBy === "nearby" ? "active" : ""}`} onClick={enableNearby}>
          <span className="chip-icon">📍</span>কাছাকাছি
        </button>
      </div>
      {locError && <div className="meta" style={{ marginBottom: 8 }}>{locError}</div>}

      <div className="filter-row" style={{ marginBottom: 10 }}>
        <select
          value={divisionId}
          onChange={(e) => { setDivisionId(e.target.value); setDistrictId(""); }}
        >
          <option value="">সব বিভাগ</option>
          {DIVISION_NAMES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select
          value={districtId}
          onChange={(e) => setDistrictId(e.target.value)}
        >
          <option value="">সব জেলা</option>
          {districtOptions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ marginBottom: 12 }}>
        <option value="new">নতুন আগে</option>
        <option value="old">পুরোনো আগে</option>
        <option value="priceLow">কম দাম আগে</option>
        <option value="priceHigh">বেশি দাম আগে</option>
        {myCoords && <option value="nearby">কাছের আগে</option>}
      </select>

      {!user && (
        <div className="card guest-cta">
          <span className="meta">দাম যোগ করতে লগইন করুন</span>
          <button className="link" onClick={onNeedLogin} style={{ padding: "6px 12px" }}>লগইন করুন</button>
        </div>
      )}

      {dbError && <div className="error-text" style={{wordBreak: "break-all"}}>{dbError}</div>}

      {filtered.length === 0 && <div className="empty">কোনো দাম পাওয়া যায়নি। ফিল্টার বদলে দেখুন।</div>}

      <div className="grid-cards">
        {filtered.map((it) => {
          const stale = ageDays(it.createdAt) > STALE_DAYS;
          const isFav = favorites.includes(it.productName);
          return (
            <div className="price-card" key={it.id} onClick={() => onOpenDetail(it.id)}>
              <div className="price-card-image">
                {it.imageUrl
                  ? <img src={it.imageUrl} alt={it.productName} />
                  : <span className="price-card-emoji">{CATEGORY_ICONS[it.categoryId] || "🛍️"}</span>}
                <span className="price-card-badge">৳{it.price}/{it.unit}</span>
                {stale && <span className="stale-badge">পুরোনো তথ্য</span>}
                <button
                  className="fav-btn"
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(user, it.productName, isFav, onNeedLogin); }}
                >
                  {isFav ? "❤️" : "🤍"}
                </button>
              </div>
              <div className="price-card-body">
                <div className="name">{it.productName}</div>
                <div className="meta">{it.upazila ? it.upazila + ", " : ""}{it.districtId}</div>
                <div className="meta time-ago">
                  {timeAgo(it.createdAt)}
                  {it._distance !== null && it._distance !== undefined && ` · ${it._distance.toFixed(1)} কিমি`}
                </div>
                <div className="card-actions">
                  <button className="vote-btn" onClick={(e) => { e.stopPropagation(); handleVote(user, it.id, "up", onNeedLogin); }}>👍 {it.upvotes || 0}</button>
                  <button className="vote-btn" onClick={(e) => { e.stopPropagation(); handleVote(user, it.id, "down", onNeedLogin); }}>👎 {it.downvotes || 0}</button>
                  <button className="vote-btn" onClick={(e) => { e.stopPropagation(); sharePrice(it); }}>📤</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PriceHistoryChart({ productName, districtId }) {
  const [history, setHistory] = useState([]);
  const [histError, setHistError] = useState("");

  useEffect(() => {
    const q = query(
      collection(db, "prices"),
      where("productName", "==", productName),
      where("districtId", "==", districtId),
      where("status", "==", "approved"),
      orderBy("createdAt", "asc"),
      limit(30)
    );
    const unsub = onSnapshot(q, (snap) => {
      setHistory(snap.docs.map((d) => d.data()));
    }, (err) => setHistError(err.message));
    return unsub;
  }, [productName, districtId]);

  if (histError) return <div className="error-text" style={{wordBreak: "break-all"}}>{histError}</div>;
  if (history.length < 2) return <div className="empty">যথেষ্ট তথ্য নেই ইতিহাস দেখানোর জন্য।</div>;

  const prices = history.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const W = 280, H = 80, pad = 6;
  const points = prices.map((p, i) => {
    const x = pad + (i * (W - pad * 2)) / (prices.length - 1);
    const y = H - pad - ((p - min) * (H - pad * 2)) / range;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
        <polyline points={points} fill="none" stroke="#E9541F" strokeWidth="2.5" />
      </svg>
      <div className="meta" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>সর্বনিম্ন ৳{min}</span>
        <span>সর্বোচ্চ ৳{max}</span>
      </div>
    </div>
  );
}

function DetailScreen({ itemId, user, onNeedLogin }) {
  const [item, setItem] = useState(null);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [dbError, setDbError] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [reportMsg, setReportMsg] = useState("");
  const favorites = useFavorites(user);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "prices", itemId), (snap) => {
      setItem(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    });
    return unsub;
  }, [itemId]);

  useEffect(() => {
    const q = query(
      collection(db, "comments"),
      where("priceId", "==", itemId),
      orderBy("createdAt", "asc")
    );
    const unsub = onSnapshot(q, (snap) => {
      setComments(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => setDbError(err.message));
    return unsub;
  }, [itemId]);

  const postComment = async (e) => {
    e.preventDefault();
    if (!user) { onNeedLogin(); return; }
    if (!commentText.trim()) return;
    setPosting(true);
    try {
      await addDoc(collection(db, "comments"), {
        priceId: itemId,
        text: commentText.trim(),
        authorEmail: user.email,
        authorName: displayName(user),
        authorPhoto: user.photoURL || null,
        authorUid: user.uid,
        createdAt: serverTimestamp(),
      });
      setCommentText("");
    } catch (err) {}
    setPosting(false);
  };

  const submitReport = async (reason) => {
    if (!user) { onNeedLogin(); return; }
    await reportPrice(user, item, reason, onNeedLogin);
    setShowReport(false);
    setReportMsg("ধন্যবাদ, আপনার রিপোর্ট এডমিনের কাছে পাঠানো হয়েছে।");
  };

  if (!item) return <div className="empty">লোড হচ্ছে...</div>;
  const link = mapLink(item);
  const stale = ageDays(item.createdAt) > STALE_DAYS;
  const isFav = favorites.includes(item.productName);

  return (
    <div>
      <div className="card">
        {item.imageUrl && <img src={item.imageUrl} alt={item.productName} className="price-thumb-large" />}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div className="name" style={{ fontSize: 18 }}>{item.productName}</div>
          <button className="fav-btn-inline" onClick={() => toggleFavorite(user, item.productName, isFav, onNeedLogin)}>
            {isFav ? "❤️" : "🤍"}
          </button>
        </div>
        <div className="amount" style={{ display: "inline-block", marginTop: 6 }}>৳{item.price}/{item.unit}</div>
        {stale && <span className="stale-badge stale-badge-inline">পুরোনো তথ্য</span>}
        <div className="meta" style={{ marginTop: 8 }}>
          {CATEGORIES.find((c) => c.id === item.categoryId)?.name || ""} · {item.upazila ? item.upazila + ", " : ""}{item.districtId}
        </div>
        <div className="meta time-ago">{timeAgo(item.createdAt)}</div>
        {link && <a href={link} target="_blank" rel="noreferrer" className="map-link">📍 মানচিত্রে দেখুন</a>}
        <div className="card-actions" style={{ marginTop: 10 }}>
          <button className="vote-btn" onClick={() => handleVote(user, itemId, "up", onNeedLogin)}>👍 {item.upvotes || 0}</button>
          <button className="vote-btn" onClick={() => handleVote(user, itemId, "down", onNeedLogin)}>👎 {item.downvotes || 0}</button>
          <button className="vote-btn" onClick={() => sharePrice(item)}>📤 শেয়ার</button>
        </div>

        {!reportMsg ? (
          <>
            <button className="ghost" style={{ marginTop: 8 }} onClick={() => setShowReport(!showReport)}>🚨 রিপোর্ট করুন</button>
            {showReport && (
              <div className="report-options">
                {REPORT_REASONS.map((r) => (
                  <button key={r} className="report-reason-btn" onClick={() => submitReport(r)}>{r}</button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="meta" style={{ marginTop: 8, color: "var(--teal)" }}>{reportMsg}</div>
        )}
      </div>

      <div className="card">
        <div className="name" style={{ marginBottom: 10 }}>📈 মূল্যের ধারা</div>
        <PriceHistoryChart productName={item.productName} districtId={item.districtId} />
      </div>

      <div className="card">
        <div className="name" style={{ marginBottom: 10 }}>কমেন্ট ({comments.length})</div>
        {dbError && <div className="error-text" style={{wordBreak: "break-all"}}>{dbError}</div>}
        {comments.length === 0 && <div className="empty">এখনো কোনো কমেন্ট নেই।</div>}
        {comments.map((c) => (
          <div key={c.id} className="comment-row">
            <div className="comment-header">
              {c.authorPhoto
                ? <img src={c.authorPhoto} alt="" className="comment-avatar" />
                : <span className="comment-avatar comment-avatar-placeholder">👤</span>}
              <div className="comment-author">{c.authorName || (c.authorEmail ? c.authorEmail.split("@")[0] : "ইউজার")}</div>
            </div>
            <div className="comment-text">{c.text}</div>
            <div className="meta time-ago">{timeAgo(c.createdAt)}</div>
          </div>
        ))}

        {user ? (
          <form onSubmit={postComment} style={{ marginTop: 10 }}>
            <textarea
              rows={2}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="একটা কমেন্ট লিখুন..."
            />
            <button className="primary" type="submit" disabled={posting} style={{ marginTop: 8 }}>
              {posting ? "পাঠানো হচ্ছে..." : "কমেন্ট করুন"}
            </button>
          </form>
        ) : (
          <button className="ghost" onClick={onNeedLogin} style={{ marginTop: 10 }}>কমেন্ট করতে লগইন করুন</button>
        )}
      </div>
    </div>
  );
}

function AddPriceScreen({ user, onDone }) {
  const [productName, setProductName] = useState("");
  const [categoryId, setCategoryId] = useState(CATEGORIES[0].id);
  const [divisionId, setDivisionId] = useState(DIVISION_NAMES[0]);
  const [districtId, setDistrictId] = useState(DIVISIONS[DIVISION_NAMES[0]][0]);
  const [upazila, setUpazila] = useState("");
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState(UNITS[0]);
  const [imageUrl, setImageUrl] = useState("");
  const [locationLink, setLocationLink] = useState("");
  const [locationLat, setLocationLat] = useState(null);
  const [locationLng, setLocationLng] = useState(null);
  const [locStatus, setLocStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const onDivisionChange = (val) => {
    setDivisionId(val);
    setDistrictId(DIVISIONS[val][0]);
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setLocStatus("এই ডিভাইসে লোকেশন সাপোর্ট নেই");
      return;
    }
    setLocStatus("লোকেশন খোঁজা হচ্ছে...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationLat(pos.coords.latitude);
        setLocationLng(pos.coords.longitude);
        setLocStatus("✓ বর্তমান লোকেশন যোগ হয়েছে");
      },
      () => setLocStatus("লোকেশন পাওয়া যায়নি, অনুমতি দিন বা লিংক ব্যবহার করুন"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    try {
      await addDoc(collection(db, "prices"), {
        productName,
        categoryId,
        districtId,
        upazila,
        price: Number(price),
        unit,
        imageUrl: imageUrl || null,
        locationLink: locationLink || null,
        locationLat: locationLat || null,
        locationLng: locationLng || null,
        postedBy: user.uid,
        postedByEmail: user.email,
        status: "pending",
        upvotes: 0,
        downvotes: 0,
        createdAt: serverTimestamp(),
      });
      setMsg("ধন্যবাদ! আপনার তথ্য অ্যাডমিন অনুমোদনের পর সবাই দেখতে পাবে।");
      setProductName(""); setPrice(""); setUpazila(""); setImageUrl("");
      setLocationLink(""); setLocationLat(null); setLocationLng(null); setLocStatus("");
    } catch (err) {
      setMsg("সেভ করা যায়নি, আবার চেষ্টা করুন।");
    }
    setSaving(false);
  };

  return (
    <form className="card" onSubmit={submit}>
      <label>পণ্যের নাম</label>
      <input required value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="যেমন: আলু, পেঁয়াজ" />

      <label>ক্যাটাগরি</label>
      <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
        {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      <label>বিভাগ</label>
      <select value={divisionId} onChange={(e) => onDivisionChange(e.target.value)}>
        {DIVISION_NAMES.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>

      <label>জেলা</label>
      <select value={districtId} onChange={(e) => setDistrictId(e.target.value)}>
        {DIVISIONS[divisionId].map((d) => <option key={d} value={d}>{d}</option>)}
      </select>

      <label>উপজেলা (ঐচ্ছিক)</label>
      <input value={upazila} onChange={(e) => setUpazila(e.target.value)} placeholder="যেমন: সাভার" />

      <label>দাম (টাকা)</label>
      <input required type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="যেমন: ৪৫" />

      <label>একক</label>
      <select value={unit} onChange={(e) => setUnit(e.target.value)}>
        {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>

      <label>ছবির লিংক (ঐচ্ছিক)</label>
      <input type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." />

      <label>দোকানের লোকেশন (ঐচ্ছিক)</label>
      <button type="button" className="ghost" onClick={useCurrentLocation} style={{ marginTop: 0 }}>
        📍 বর্তমান লোকেশন ব্যবহার করুন
      </button>
      {locStatus && <div className="meta" style={{ marginTop: 6 }}>{locStatus}</div>}

      <label>অথবা Google Maps লিংক পেস্ট করুন</label>
      <input value={locationLink} onChange={(e) => setLocationLink(e.target.value)} placeholder="https://maps.app.goo.gl/..." />

      {msg && <div className="error-text" style={{ color: "var(--teal)" }}>{msg}</div>}
      <button className="primary" type="submit" disabled={saving}>
        {saving ? "সেভ হচ্ছে..." : "দাম জমা দিন"}
      </button>
    </form>
  );
}

function ProfileScreen({ user, onOpenDetail }) {
  const [items, setItems] = useState([]);
  const [dbError, setDbError] = useState("");
  const [name, setName] = useState(user.displayName || "");
  const [photoUrl, setPhotoUrl] = useState(user.photoURL || "");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => {
    const q = query(
      collection(db, "prices"),
      where("postedBy", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => setDbError(err.message));
    return unsub;
  }, [user]);

  const remove = async (id, e) => {
    e.stopPropagation();
    await deleteDoc(doc(db, "prices", id));
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveMsg("");
    try {
      await updateProfile(auth.currentUser, {
        displayName: name.trim() || null,
        photoURL: photoUrl.trim() || null,
      });
      setSaveMsg("✓ প্রোফাইল সেভ হয়েছে");
    } catch (err) {
      setSaveMsg("সেভ করা যায়নি, আবার চেষ্টা করুন");
    }
    setSaving(false);
  };

  const approvedCount = items.filter((i) => i.status === "approved").length;
  const badge = reputationBadge(approvedCount);

  return (
    <div>
      <form className="card" onSubmit={saveProfile}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          {photoUrl
            ? <img src={photoUrl} alt="" className="profile-avatar" />
            : <span className="profile-avatar profile-avatar-placeholder">👤</span>}
          <div>
            <div className="meta">{user.email}</div>
            <div className="reputation-badge">{badge.icon} {badge.label} · {approvedCount}টা অনুমোদিত পোস্ট</div>
          </div>
        </div>

        <label>নাম</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="আপনার নাম লিখুন" />

        <label>প্রোফাইল ছবির লিংক (ঐচ্ছিক)</label>
        <input type="url" value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://..." />

        {saveMsg && <div className="meta" style={{ marginTop: 8, color: "var(--teal)" }}>{saveMsg}</div>}
        <button className="primary" type="submit" disabled={saving}>
          {saving ? "সেভ হচ্ছে..." : "প্রোফাইল সেভ করুন"}
        </button>
      </form>

      <div className="card">
        <div className="name" style={{ marginBottom: 8 }}>আমার পোস্ট করা দাম</div>
        {dbError && <div className="error-text" style={{wordBreak: "break-all"}}>{dbError}</div>}
        {items.length === 0 && <div className="empty">আপনি এখনো কোনো দাম যোগ করেননি।</div>}
        {items.map((it) => (
          <div className="price-row" key={it.id} onClick={() => onOpenDetail(it.id)}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {it.imageUrl && <img src={it.imageUrl} alt={it.productName} className="price-thumb" />}
              <div>
                <div className="name">
                  {it.productName}
                  <span className={`badge ${it.status}`}>
                    {it.status === "pending" ? "অপেক্ষমান" : it.status === "approved" ? "অনুমোদিত" : "বাতিল"}
                  </span>
                </div>
                <div className="meta">{it.districtId} · ৳{it.price}/{it.unit} · {timeAgo(it.createdAt)}</div>
              </div>
            </div>
            <button className="link" onClick={(e) => remove(it.id, e)}>ডিলিট</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminScreen() {
  const [items, setItems] = useState([]);
  const [allForStats, setAllForStats] = useState([]);
  const [reports, setReports] = useState([]);
  const [dbError, setDbError] = useState("");
  const [announceText, setAnnounceText] = useState("");
  const [sending, setSending] = useState(false);
  const announcement = useLatestAnnouncement();

  useEffect(() => {
    const q = query(
      collection(db, "prices"),
      where("status", "==", "pending"),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => setDbError(err.message));
    return unsub;
  }, []);

  useEffect(() => {
    const q = query(collection(db, "prices"), orderBy("createdAt", "desc"), limit(1000));
    const unsub = onSnapshot(q, (snap) => {
      setAllForStats(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const q = query(
      collection(db, "reports"),
      where("status", "==", "open"),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      setReports(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => {});
    return unsub;
  }, []);

  const act = async (id, status) => {
    await updateDoc(doc(db, "prices", id), { status });
  };

  const resolveReport = async (id) => {
    await updateDoc(doc(db, "reports", id), { status: "resolved" });
  };

  const sendAnnouncement = async (e) => {
    e.preventDefault();
    if (!announceText.trim()) return;
    setSending(true);
    try {
      await addDoc(collection(db, "announcements"), {
        message: announceText.trim(),
        createdAt: serverTimestamp(),
      });
      setAnnounceText("");
    } catch (err) {}
    setSending(false);
  };

  const removeAnnouncement = async () => {
    if (announcement) await deleteDoc(doc(db, "announcements", announcement.id));
  };

  const totalPosts = allForStats.length;
  const todayPosts = allForStats.filter((i) => ageDays(i.createdAt) < 1).length;
  const approvedCount = allForStats.filter((i) => i.status === "approved").length;
  const rejectedCount = allForStats.filter((i) => i.status === "rejected").length;
  const categoryCounts = {};
  const productCounts = {};
  allForStats.forEach((i) => {
    categoryCounts[i.categoryId] = (categoryCounts[i.categoryId] || 0) + 1;
    productCounts[i.productName] = (productCounts[i.productName] || 0) + 1;
  });
  const topCategoryId = Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a])[0];
  const topCategoryName = CATEGORIES.find((c) => c.id === topCategoryId)?.name || "-";
  const topProduct = Object.keys(productCounts).sort((a, b) => productCounts[b] - productCounts[a])[0] || "-";

  const generateDailyReport = () => {
    const todayApproved = allForStats.filter((i) => i.status === "approved" && ageDays(i.createdAt) < 1);
    if (todayApproved.length === 0) {
      alert("আজকে অনুমোদিত কোনো দাম নেই।");
      return;
    }
    const byDistrict = {};
    todayApproved.forEach((i) => {
      if (!byDistrict[i.districtId]) byDistrict[i.districtId] = [];
      byDistrict[i.districtId].push(i);
    });
    let text = `📊 আজকের বাজার দর রিপোর্ট\n\n`;
    Object.keys(byDistrict).forEach((d) => {
      text += `📍 ${d}\n`;
      byDistrict[d].forEach((i) => {
        text += `  • ${i.productName}: ৳${i.price}/${i.unit}\n`;
      });
      text += `\n`;
    });
    text += `— বাংলাদেশ বাজার দর অ্যাপ`;
    shareText(text);
  };

  return (
    <div>
      <div className="card">
        <div className="name" style={{ marginBottom: 8 }}>📊 পরিসংখ্যান</div>
        <div className="stats-grid">
          <div className="stat-box"><div className="stat-num">{totalPosts}</div><div className="stat-label">মোট পোস্ট</div></div>
          <div className="stat-box"><div className="stat-num">{todayPosts}</div><div className="stat-label">আজকের পোস্ট</div></div>
          <div className="stat-box"><div className="stat-num">{items.length}</div><div className="stat-label">অপেক্ষমান</div></div>
          <div className="stat-box"><div className="stat-num">{approvedCount}</div><div className="stat-label">অনুমোদিত</div></div>
          <div className="stat-box"><div className="stat-num">{rejectedCount}</div><div className="stat-label">বাতিল</div></div>
          <div className="stat-box"><div className="stat-num">{reports.length}</div><div className="stat-label">রিপোর্ট</div></div>
        </div>
        <div className="meta" style={{ marginTop: 10 }}>সবচেয়ে বেশি ব্যবহৃত ক্যাটাগরি: <b>{topCategoryName}</b></div>
        <div className="meta">সবচেয়ে বেশি পোস্ট করা পণ্য: <b>{topProduct}</b></div>
        <button className="ghost" style={{ marginTop: 10 }} onClick={generateDailyReport}>🧾 আজকের রিপোর্ট শেয়ার করুন</button>
      </div>

      <div className="card">
        <div className="name" style={{ marginBottom: 8 }}>📢 ঘোষণা</div>
        {announcement && (
          <div className="announcement-preview">
            <span>{announcement.message}</span>
            <button className="link" onClick={removeAnnouncement}>মুছুন</button>
          </div>
        )}
        <form onSubmit={sendAnnouncement}>
          <textarea
            rows={2}
            value={announceText}
            onChange={(e) => setAnnounceText(e.target.value)}
            placeholder="নতুন ঘোষণা লিখুন..."
          />
          <button className="primary" type="submit" disabled={sending} style={{ marginTop: 8 }}>
            {sending ? "পাঠানো হচ্ছে..." : "ঘোষণা পাঠান"}
          </button>
        </form>
      </div>

      <div className="card">
        <div className="name" style={{ marginBottom: 8 }}>🚨 রিপোর্ট হওয়া পোস্ট ({reports.length})</div>
        {reports.length === 0 && <div className="empty">কোনো রিপোর্ট নেই।</div>}
        {reports.map((r) => (
          <div className="price-row" key={r.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div className="name">{r.productName} — ৳{r.price}/{r.unit}</div>
            <div className="meta">{r.districtId} · কারণ: {r.reason} · রিপোর্টকারী: {r.reporterEmail}</div>
            <button className="ghost" style={{ marginTop: 6 }} onClick={() => resolveReport(r.id)}>সমাধান হয়েছে হিসেবে চিহ্নিত করুন</button>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="name" style={{ marginBottom: 8 }}>✅ অপেক্ষমান দাম</div>
        {dbError && <div className="error-text" style={{wordBreak: "break-all"}}>{dbError}</div>}
        {items.length === 0 && <div className="empty">অপেক্ষমান কোনো পোস্ট নেই।</div>}
        {items.map((it) => {
          const link = mapLink(it);
          return (
            <div className="price-row" key={it.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
              {it.imageUrl && <img src={it.imageUrl} alt={it.productName} className="price-thumb-large" />}
              <div className="name">{it.productName} — ৳{it.price}/{it.unit}</div>
              <div className="meta">{it.districtId}{it.upazila ? ", " + it.upazila : ""} · {it.postedByEmail} · {timeAgo(it.createdAt)}</div>
              {link && <a href={link} target="_blank" rel="noreferrer" className="map-link">📍 মানচিত্রে দেখুন</a>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="primary" style={{ marginTop: 0 }} onClick={() => act(it.id, "approved")}>অনুমোদন</button>
                <button className="ghost" style={{ marginTop: 0 }} onClick={() => act(it.id, "rejected")}>বাতিল</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}