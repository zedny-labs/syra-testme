import React from 'react'
import { Navigate } from 'react-router-dom'
import useAuth from '../../hooks/useAuth'
import Loader from '../../components/common/Loader/Loader'

// Public marketing landing — the standalone 3D "VAR EXAM" experience lives as a
// static site under /public/landing and is embedded here in an isolated iframe so
// its Three.js / GSAP / Spline scripts never collide with the React app lifecycle.
// Its CTAs (Request Demo / Contact Us) navigate the top window to /login.
export default function Landing() {
  const { user, loading } = useAuth()

  if (loading) return <Loader fullPage label="Loading" />
  // Authenticated visitors skip the marketing page and go straight to the app.
  if (user) return <Navigate to="/" replace />

  return (
    <iframe
      title="VAR EXAM"
      src="/landing/index.html"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        border: 0,
        margin: 0,
        padding: 0,
        display: 'block',
        background: '#000',
      }}
    />
  )
}
