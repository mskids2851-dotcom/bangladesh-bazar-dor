import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDlLpptKvrAsrxboDlAnAT4ynEqVrGOT8o",
  authDomain: "bangladesh-bazar-dor-b4fe7.firebaseapp.com",
  projectId: "bangladesh-bazar-dor-b4fe7",
  storageBucket: "bangladesh-bazar-dor-b4fe7.firebasestorage.app",
  messagingSenderId: "792466596886",
  appId: "1:792466596886:web:4abba800738e7168b70137"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const ADMIN_EMAILS = ["mdmasudislam9525@gmail.com"];