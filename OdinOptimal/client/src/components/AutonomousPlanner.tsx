import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Plotly from "plotly.js-dist-min"
import createPlotlyComponent from "react-plotly.js/factory"
const Plot = createPlotlyComponent(Plotly)
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"

// Simple orbital helpers (km units)
const EARTH_RADIUS = 6371
const MOON_RADIUS = 1737
const EARTH_MOON_DISTANCE = 384400

function hohmannEllipsePoints(r1: number, r2: number, samples = 200) {
  const a = (r1 + r2) / 2
  const e = Math.abs(r2 - r1) / (r1 + r2)
  const points = [] as { x: number; y: number; z: number }[]
  for (let i = 0; i < samples; i++) {
    const theta = (i / (samples - 1)) * Math.PI // half ellipse
    const r = (a * (1 - e * e)) / (1 + e * Math.cos(theta))
    points.push({ x: r * Math.cos(theta), y: r * Math.sin(theta), z: 0 })
  }
  return { a, e, points }
}

type DecisionLog = { timestamp: string; type: string; message: string; meta?: any }

type PlannerState = "idle" | "running" | "error" | "completed"

export default function AutonomousPlanner() {
  const [timestamp, setTimestamp] = useState<string>("2014-07-14T12:00")
  const [backendUrl, setBackendUrl] = useState<string>(() => localStorage.getItem("PY_BACKEND_URL") || "")
  const [plannerState, setPlannerState] = useState<PlannerState>("idle")
  const [trajectoryPoints, setTrajectoryPoints] = useState<{ x: number; y: number; z: number }[]>([])
  const [metrics, setMetrics] = useState<{ deltaV?: number; transferTimeHours?: number; fuelEfficiency?: number } | null>(null)
  const [risk, setRisk] = useState<any>(null)
  const [logs, setLogs] = useState<DecisionLog[]>([])
  const pollRef = useRef<number | null>(null)

  const [localMode, setLocalMode] = useState<boolean>(() => localStorage.getItem("LOCAL_MODE") === "1")
  const [datasetUrl, setDatasetUrl] = useState<string>(() => localStorage.getItem("SPACE_WEATHER_DATA_URL") || "")
  const [datasetJson, setDatasetJson] = useState<any>(null)

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  const baseUrl = useMemo(() => backendUrl.trim().replace(/\/?$/, ""), [backendUrl])
  const apiBase = baseUrl || "/py"

  const appendLog = useCallback((entry: DecisionLog) => {
    setLogs((prev) => [{ ...entry }, ...prev].slice(0, 200))
  }, [])

  const saveBackendUrl = () => {
    localStorage.setItem("PY_BACKEND_URL", backendUrl.trim())
    appendLog({ timestamp: new Date().toISOString(), type: "info", message: `Backend set to ${backendUrl.trim()}` })
  }

  const saveDatasetUrl = () => {
    localStorage.setItem("SPACE_WEATHER_DATA_URL", datasetUrl.trim())
    appendLog({ timestamp: new Date().toISOString(), type: "info", message: `Dataset set to ${datasetUrl.trim()}` })
  }

  const setLocalModePersist = (v: boolean) => {
    setLocalMode(v)
    localStorage.setItem("LOCAL_MODE", v ? "1" : "0")
    appendLog({ timestamp: new Date().toISOString(), type: "info", message: `Local mode ${v ? "enabled" : "disabled"}` })
  }

  async function loadLocalDataset(): Promise<any> {
    if (!datasetUrl.trim()) throw new Error("Dataset URL is required for local mode")
    const res = await fetch(datasetUrl.trim(), { cache: "no-store" })
    if (!res.ok) throw new Error(`Dataset fetch failed (${res.status})`)
    const data = await res.json()
    setDatasetJson(data)
    appendLog({ timestamp: new Date().toISOString(), type: "info", message: "Dataset loaded" })
    return data
  }

  function severityToRisk(sev: string): number {
    const s = (sev || "").toLowerCase()
    if (s.includes("critical")) return 0.9
    if (s.includes("high")) return 0.7
    if (s.includes("moderate") || s.includes("medium")) return 0.45
    if (s.includes("low")) return 0.2
    return 0.3
  }

  function buildLocalThreats(epochIso: string): any {
    const start = new Date(epochIso)
    const end = new Date(start.getTime() + 3 * 24 * 3600 * 1000)
    const data = datasetJson || {}
    const events: any[] = Array.isArray(data.major_events) ? data.major_events : []

    const inWindow = events.filter((e) => {
      const d = new Date(e.date || e.timestamp || 0)
      return d >= start && d <= end
    })

    const riskItems = inWindow.map((e) => ({
      timestamp: new Date(e.date || e.timestamp).toISOString(),
      risk_score: severityToRisk(e.severity),
      event: e,
    }))
    const overallRisk = riskItems.length
      ? Math.min(0.95, riskItems.reduce((a, b) => a + b.risk_score, 0) / riskItems.length)
      : 0.25

    const solar_activity = {
      forecast_period: { start: start.toISOString(), end: end.toISOString() },
      forecast_data: [],
      high_risk_periods: riskItems,
      summary: inWindow.length ? ["Elevated risk from historical events in window"] : ["Low to moderate solar activity expected"],
    }

    const recommendations: string[] = []
    if (overallRisk > 0.6) recommendations.push("Delay burn window or increase shielding")
    if (overallRisk > 0.4) recommendations.push("Increase monitoring and consider contingency maneuvers")

    return {
      success: true,
      threats: {
        solar_activity,
        space_debris: { total_risk_score: overallRisk * 0.02 },
        radiation_exposure: { crew_safety: overallRisk > 0.6 ? "critical" : overallRisk > 0.4 ? "elevated_risk" : "safe" },
        communication_blackouts: [],
      },
      risk_assessment: {
        overall_risk: overallRisk,
      },
      recommendations,
    }
  }

  async function parseJsonSafe(res: Response) {
    const ct = res.headers.get("content-type") || ""
    if (ct.includes("application/json")) return res.json()
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText} - ${text.slice(0,140)}`)
  }

  async function warmupBackend() {
    appendLog({ timestamp: new Date().toISOString(), type: "info", message: "Warming up backend..." })
    const maxAttempts = 8
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${apiBase}/api/health`, { cache: "no-store" })
        if (res.ok) {
          const ct = res.headers.get("content-type") || ""
          if (ct.includes("application/json")) return true
        }
      } catch {}
      await new Promise(r => setTimeout(r, Math.min(500 * Math.pow(1.5, i), 4000)))
    }
    return false
  }

  const runPipeline = useCallback(async () => {
    try {
      setPlannerState("running")
      setLogs([])

      // 1) Initial trajectory plan (optimize / or local)
      const r1 = EARTH_RADIUS + 200
      const r2 = EARTH_MOON_DISTANCE
      const nowIso = new Date(timestamp).toISOString()

      if (localMode) {
        const mu = 398600
        const a = (r1 + r2) / 2
        const v1 = Math.sqrt(mu / r1)
        const v2 = Math.sqrt(mu / r2)
        const vPer = Math.sqrt(mu * (2 / r1 - 1 / a))
        const vApo = Math.sqrt(mu * (2 / r2 - 1 / a))
        const deltaV = Math.abs(vPer - v1) + Math.abs(v2 - vApo)
        const tSec = Math.PI * Math.sqrt(Math.pow(a, 3) / mu)

        const { points } = hohmannEllipsePoints(r1, r2)
        setTrajectoryPoints(points)
        setMetrics({ deltaV, transferTimeHours: tSec / 3600, fuelEfficiency: Math.max(0, 100 - deltaV / 10) })

        if (!datasetJson) await loadLocalDataset()
        appendLog({ timestamp: nowIso, type: "info", message: "Analyzing threats (local)" })
        const thJson = buildLocalThreats(nowIso)
        setRisk(thJson)

        const riskVal = thJson?.risk_assessment?.overall_risk || 0
        const decision = riskVal > 0.6 ? "delay_orbit_insertion" : "proceed_with_caution"
        appendLog({ timestamp: new Date().toISOString(), type: "decision", message: `Local decision: ${decision}`, meta: { risk: riskVal } })

        if (pollRef.current) window.clearInterval(pollRef.current)
        setPlannerState("completed")
        return
      }

      // Warm up backend (Render free instances show an interstitial while waking)
      const ready = await warmupBackend()
      if (!ready) appendLog({ timestamp: new Date().toISOString(), type: "warn", message: "Backend may still be waking. Continuing..." })

      appendLog({ timestamp: nowIso, type: "info", message: "Requesting optimal trajectory" })
      const optRes = await fetch(`${apiBase}/api/trajectory/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_position: [r1, 0, 0],
          end_position: [r2, 0, 0],
          constraints: { epoch: nowIso },
          fuel_weight: 0.4,
          time_weight: 0.3,
          safety_weight: 0.3,
        }),
      })
      if (!optRes.ok) throw new Error(`Optimize failed (${optRes.status})`)
      const optJson = await parseJsonSafe(optRes)

      const best = optJson.optimal_trajectory?.optimal_trajectory || optJson.optimal_trajectory || optJson
      const a = best?.semi_major_axis || (r1 + r2) / 2
      const e = best?.eccentricity ?? Math.abs(r2 - r1) / (r1 + r2)
      const { points } = hohmannEllipsePoints(r1, r2)
      setTrajectoryPoints(points)
      setMetrics({
        deltaV: best?.delta_v_total,
        transferTimeHours: (best?.transfer_time || 0) / 3600,
        fuelEfficiency: best?.fuel_efficiency,
      })

      // 2) Threat analysis
      appendLog({ timestamp: new Date().toISOString(), type: "info", message: "Analyzing threats" })
      const thRes = await fetch(`${apiBase}/api/threats/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mission_id: "demo",
          trajectory: best,
          start_time: nowIso,
          end_time: new Date(new Date(timestamp).getTime() + 3 * 24 * 3600 * 1000).toISOString(),
        }),
      })
      if (!thRes.ok) throw new Error(`Threat analysis failed (${thRes.status})`)
      const thJson = await parseJsonSafe(thRes)
      setRisk(thJson)

      // 3) AI decision
      appendLog({ timestamp: new Date().toISOString(), type: "info", message: "Requesting AI decision" })
      const decRes = await fetch(`${apiBase}/api/decisions/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mission_id: "demo",
          current_trajectory: best,
          threats: thJson,
          constraints: { epoch: nowIso },
          criteria: { fuel_efficiency: 0.4, travel_time: 0.3, safety: 0.3 },
        }),
      })
      if (!decRes.ok) throw new Error(`Decision failed (${decRes.status})`)
      const decJson = await parseJsonSafe(decRes)
      appendLog({ timestamp: new Date().toISOString(), type: "decision", message: "AI decision generated", meta: decJson })

      // Optional replanning if risk high
      const overall = thJson?.risk_assessment?.overall_risk || 0
      if (overall > 0.6) {
        appendLog({ timestamp: new Date().toISOString(), type: "warn", message: "High risk detected. Replanning..." })
        const replanRes = await fetch(`${apiBase}/api/decisions/replan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mission_id: "demo", reason: "high_risk", emergency_level: "medium" }),
        })
        if (replanRes.ok) {
          const replanJson = await replanRes.json()
          appendLog({ timestamp: new Date().toISOString(), type: "decision", message: "Replan complete", meta: replanJson })
        }
      }

      // Start decision history polling
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        try {
          const h = await fetch(`${apiBase}/api/decisions/history?limit=20`)
          if (!h.ok) return
          const j = await parseJsonSafe(h)
          const entries: DecisionLog[] = (j.decisions || []).map((d: any) => ({
            timestamp: d.timestamp || new Date().toISOString(),
            type: d.decision_type || "decision",
            message: d.reasoning || "Decision update",
            meta: d,
          }))
          setLogs(entries)
        } catch {}
      }, 3000)

      setPlannerState("completed")
    } catch (err: any) {
      setPlannerState("error")
      appendLog({ timestamp: new Date().toISOString(), type: "error", message: err?.message || "Pipeline failed" })
    }
  }, [appendLog, baseUrl, timestamp, localMode, datasetUrl, datasetJson])

  const plotData = useMemo(() => {
    const earthOrbit = {
      x: Array.from({ length: 200 }, (_, i) => (EARTH_RADIUS + 200) * Math.cos((i / 199) * 2 * Math.PI)),
      y: Array.from({ length: 200 }, (_, i) => (EARTH_RADIUS + 200) * Math.sin((i / 199) * 2 * Math.PI)),
      z: Array(200).fill(0),
      type: "scatter3d" as const,
      mode: "lines",
      name: "LEO",
      line: { color: "#6b7280" },
    }
    const moonOrbit = {
      x: Array.from({ length: 200 }, (_, i) => EARTH_MOON_DISTANCE * Math.cos((i / 199) * 2 * Math.PI)),
      y: Array.from({ length: 200 }, (_, i) => EARTH_MOON_DISTANCE * Math.sin((i / 199) * 2 * Math.PI)),
      z: Array(200).fill(0),
      type: "scatter3d" as const,
      mode: "lines",
      name: "Moon Orbit",
      line: { color: "#94a3b8" },
    }
    const transfer = trajectoryPoints.length
      ? {
          x: trajectoryPoints.map((p) => p.x),
          y: trajectoryPoints.map((p) => p.y),
          z: trajectoryPoints.map((p) => p.z),
          type: "scatter3d" as const,
          mode: "lines+markers",
          name: "Transfer",
          line: { color: "#f97316", width: 4 },
          marker: { size: 2, color: "#f59e0b" },
        }
      : null
    return [earthOrbit, moonOrbit, transfer].filter(Boolean)
  }, [trajectoryPoints])

  const plotLayout = {
    autosize: true,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    scene: {
      xaxis: { title: "km", gridcolor: "#334155", zerolinecolor: "#334155", color: "#e5e7eb" },
      yaxis: { title: "km", gridcolor: "#334155", zerolinecolor: "#334155", color: "#e5e7eb" },
      zaxis: { title: "km", gridcolor: "#334155", zerolinecolor: "#334155", color: "#e5e7eb" },
      aspectmode: "data" as const,
    },
    margin: { l: 0, r: 0, t: 0, b: 0 },
    showlegend: true,
    legend: { font: { color: "#e5e7eb" } },
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      <Card className="bg-white/5 backdrop-blur-sm border-white/10 xl:col-span-2">
        <CardContent className="p-4 md:p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-mission-orange/20 text-mission-orange border-mission-orange">Autonomous Planner</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="local-mode" className="text-white/80">Local mode</Label>
                <Switch id="local-mode" checked={localMode} onCheckedChange={setLocalModePersist} />
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="dataset" className="text-white/80">Dataset</Label>
                <Input id="dataset" placeholder="https://...space_weather.json" value={datasetUrl} onChange={(e) => setDatasetUrl(e.target.value)} className="w-64 bg-white/10 border-white/20 text-white placeholder:text-white/50" />
                <Button size="sm" variant="outline" className="border-white/30 text-white hover:bg-white/10" onClick={saveDatasetUrl}>Save</Button>
                <Button size="sm" className="bg-mission-orange hover:bg-mission-orange/90 text-white" onClick={() => loadLocalDataset()}>Load</Button>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="backend" className="text-white/80">Backend</Label>
                <Input id="backend" placeholder="https://your-flask-host" value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} className="w-64 bg-white/10 border-white/20 text-white placeholder:text-white/50" />
                <Button size="sm" variant="outline" className="border-white/30 text-white hover:bg-white/10" onClick={saveBackendUrl}>Save</Button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <Label htmlFor="timestamp" className="text-white/80">Epoch (2012-2018)</Label>
              <Input
                id="timestamp"
                type="datetime-local"
                min="2012-01-01T00:00"
                max="2018-12-31T23:59"
                value={timestamp}
                onChange={(e) => setTimestamp(e.target.value)}
                className="bg-white/10 border-white/20 text-white"
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={runPipeline}
                className="w-full bg-mission-orange hover:bg-mission-orange/90 text-white"
                disabled={plannerState === "running"}
              >
                {plannerState === "running" ? "Planning…" : "Start Autonomous Planning"}
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-white/80">
              <div className="p-3 rounded-md bg-white/5 border border-white/10">
                <div className="text-xs text-white/60">ΔV (m/s)</div>
                <div className="text-lg font-semibold">{metrics?.deltaV ? metrics.deltaV.toFixed(0) : "—"}</div>
              </div>
              <div className="p-3 rounded-md bg-white/5 border border-white/10">
                <div className="text-xs text-white/60">Time (h)</div>
                <div className="text-lg font-semibold">{metrics?.transferTimeHours ? metrics.transferTimeHours.toFixed(1) : "—"}</div>
              </div>
              <div className="p-3 rounded-md bg-white/5 border border-white/10">
                <div className="text-xs text-white/60">Fuel (%)</div>
                <div className="text-lg font-semibold">{metrics?.fuelEfficiency ? metrics.fuelEfficiency.toFixed(0) : "—"}</div>
              </div>
            </div>
          </div>

          <div className="h-[480px] rounded-md overflow-hidden border border-white/10">
            <Plot data={plotData as any} layout={plotLayout as any} style={{ width: "100%", height: "100%" }} config={{ displayModeBar: true }} />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Card className="bg-white/5 backdrop-blur-sm border-white/10">
          <CardContent className="p-4 md:p-6">
            <h3 className="text-white font-semibold mb-3">Real-time Decision Logs</h3>
            <div className="h-[540px] overflow-auto space-y-3 pr-2">
              {logs.length === 0 && <div className="text-white/60">No logs yet. Start planning to see updates.</div>}
              {logs.map((l, idx) => (
                <div key={idx} className="p-3 rounded-md border border-white/10 bg-white/5">
                  <div className="text-xs text-white/60">{new Date(l.timestamp).toLocaleString()}</div>
                  <div className="text-white">[{l.type}] {l.message}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white/5 backdrop-blur-sm border-white/10">
          <CardContent className="p-4 md:p-6">
            <h3 className="text-white font-semibold mb-3">Risk Assessment</h3>
            <pre className="text-xs text-white/80 whitespace-pre-wrap break-words max-h-[220px] overflow-auto">{risk ? JSON.stringify(risk, null, 2) : "No analysis yet."}</pre>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
