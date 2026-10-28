import React, { useState, useEffect } from 'react';
import { 
  Network, Server, Cpu, Play, RefreshCw, Zap, ShieldCheck, 
  Activity, CheckCircle2, Lock, ArrowRight, Radio, Sparkles
} from 'lucide-react';
import Button from '../ui/Button';
import Badge from '../ui/Badge';

export default function CitusShardSimulation() {
  const [activeSimulation, setActiveSimulation] = useState(null);
  const [packetPositions, setPacketPositions] = useState([0, 0, 0, 0]);
  const [queryCount, setQueryCount] = useState(148290);
  const [avgLatency, setAvgLatency] = useState(1.8);
  const [simulationLogs, setSimulationLogs] = useState([
    { id: 1, text: 'Cluster catalog synced: 128 active hash shards across 4 worker nodes.', time: '19:40:02', type: 'info' },
    { id: 2, text: 'PgBouncer connection pool primed. 0ms wait queue.', time: '19:40:15', type: 'success' },
    { id: 3, text: 'Anti-oversell invariant monitor: 0 cabin count anomalies detected.', time: '19:40:30', type: 'success' },
  ]);

  // Workers state
  const [workers, setWorkers] = useState([
    { id: 1, name: 'Worker Node 1', host: 'worker-1:5432', shards: '32 Shards (102001-102032)', load: 24, status: 'ONLINE', ping: '1.9ms', activeTransactions: 14 },
    { id: 2, name: 'Worker Node 2', host: 'worker-2:5432', shards: '32 Shards (102033-102064)', load: 28, status: 'ONLINE', ping: '2.1ms', activeTransactions: 19 },
    { id: 3, name: 'Worker Node 3', host: 'worker-3:5432', shards: '32 Shards (102065-102096)', load: 22, status: 'ONLINE', ping: '1.8ms', activeTransactions: 12 },
    { id: 4, name: 'Worker Node 4', host: 'worker-4:5432', shards: '32 Shards (102097-102128)', load: 31, status: 'ONLINE', ping: '2.4ms', activeTransactions: 22 },
  ]);

  // Live heartbeats
  useEffect(() => {
    const timer = setInterval(() => {
      setQueryCount((prev) => prev + Math.floor(Math.random() * 8) + 3);
      setAvgLatency((prev) => +(1.6 + Math.random() * 0.5).toFixed(2));
      setWorkers((prev) =>
        prev.map((w) => ({
          ...w,
          load: Math.min(95, Math.max(12, w.load + (Math.random() > 0.5 ? 2 : -2))),
          activeTransactions: Math.max(5, w.activeTransactions + (Math.random() > 0.5 ? 1 : -1)),
        }))
      );
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const addLog = (text, type = 'info') => {
    const now = new Date().toLocaleTimeString();
    setSimulationLogs((prev) => [
      { id: Date.now() + Math.random(), text, time: now, type },
      ...prev.slice(0, 7),
    ]);
  };

  const triggerFanoutSimulation = () => {
    setActiveSimulation('FANOUT');
    addLog('⚡ Coordinator broadcasting parallel read fanout across all 128 distributed shards...', 'info');
    
    // Animate packets
    let step = 0;
    const interval = setInterval(() => {
      step += 15;
      setPacketPositions([step, step, step, step]);
      if (step >= 100) {
        clearInterval(interval);
        setTimeout(() => {
          setPacketPositions([0, 0, 0, 0]);
          setActiveSimulation(null);
          addLog('✓ Parallel fanout complete. 4 worker responses aggregated in 2.1ms. Zero cross-node joins required.', 'success');
        }, 400);
      }
    }, 40);
  };

  const trigger2PCSagaSimulation = () => {
    setActiveSimulation('2PC');
    addLog('🔒 Initiating 2-Phase Distributed Commit Saga for Seat Booking (PK-785)...', 'warning');
    
    // Animate packets to worker 2 and 3
    let step = 0;
    const interval = setInterval(() => {
      step += 15;
      setPacketPositions([0, step, step, 0]);
      if (step >= 100) {
        clearInterval(interval);
        setTimeout(() => {
          setPacketPositions([0, 0, 0, 0]);
          setActiveSimulation(null);
          addLog('✓ Distributed 2PC Prepared & Committed. Inventory counter locked and decremented on Worker 2.', 'success');
        }, 500);
      }
    }, 40);
  };

  const triggerOversellMutexSimulation = () => {
    setActiveSimulation('MUTEX');
    addLog('🛡️ High-Concurrency Race Simulation: 10 simultaneous requests targeting the final seat on Cabin ECONOMY...', 'warning');

    let step = 0;
    const interval = setInterval(() => {
      step += 15;
      setPacketPositions([step, step, step, step]);
      if (step >= 100) {
        clearInterval(interval);
        setTimeout(() => {
          setPacketPositions([0, 0, 0, 0]);
          setActiveSimulation(null);
          addLog('✓ Invariant Proven: 1 request acquired row-level lock (Status: CONFIRMED). 9 requests received 409 SEAT_UNAVAILABLE with 0 oversell!', 'success');
        }, 500);
      }
    }, 40);
  };

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-glass-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-xl)',
        padding: '1.75rem',
        boxShadow: 'var(--shadow-lg)',
        backdropFilter: 'blur(20px)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background radial glow */}
      <div
        style={{
          position: 'absolute',
          top: '-20%',
          right: '-10%',
          width: '450px',
          height: '450px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(99, 102, 241, 0.12) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* Header Bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(99, 102, 241, 0.15)',
              border: '1px solid rgba(99, 102, 241, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-primary)',
              boxShadow: '0 0 15px rgba(99, 102, 241, 0.25)',
            }}
          >
            <Network size={24} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h2 style={{ fontSize: '1.3rem', fontWeight: '800', letterSpacing: '-0.01em', margin: 0 }}>
                Live Citus Distributed Shard Mesh Simulation
              </h2>
              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(16, 185, 129, 0.15)',
                  color: 'var(--status-success)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  fontWeight: '700',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block' }} />
                REAL-TIME MESH
              </span>
            </div>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
              Interactive visualizer showing query broadcast, row-level counter isolation, and 2PC sagas across worker partitions.
            </p>
          </div>
        </div>

        {/* Global Stats Counters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Queries Routed</div>
            <div style={{ fontSize: '1.25rem', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {queryCount.toLocaleString()}
            </div>
          </div>
          <div style={{ height: '30px', width: '1px', backgroundColor: 'var(--border-color)' }} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>p99 Latency</div>
            <div style={{ fontSize: '1.25rem', fontWeight: '800', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
              {avgLatency}ms
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Simulation Controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          backgroundColor: 'var(--bg-secondary)',
          padding: '0.75rem 1rem',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-color)',
        }}
      >
        <span style={{ fontSize: '0.82rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Trigger High-Speed Simulation:
        </span>

        <button
          onClick={triggerFanoutSimulation}
          disabled={activeSimulation !== null}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.45rem 0.9rem',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.84rem',
            fontWeight: '600',
            backgroundColor: activeSimulation === 'FANOUT' ? 'var(--accent-primary)' : 'rgba(99, 102, 241, 0.15)',
            color: activeSimulation === 'FANOUT' ? '#ffffff' : 'var(--accent-primary)',
            border: '1px solid rgba(99, 102, 241, 0.35)',
            cursor: activeSimulation ? 'not-allowed' : 'pointer',
            transition: 'all var(--transition-fast)',
          }}
        >
          <Zap size={14} />
          Simulate Parallel Query Fanout
        </button>

        <button
          onClick={trigger2PCSagaSimulation}
          disabled={activeSimulation !== null}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.45rem 0.9rem',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.84rem',
            fontWeight: '600',
            backgroundColor: activeSimulation === '2PC' ? 'var(--accent-cyan)' : 'rgba(6, 182, 212, 0.15)',
            color: activeSimulation === '2PC' ? '#ffffff' : 'var(--accent-cyan)',
            border: '1px solid rgba(6, 182, 212, 0.35)',
            cursor: activeSimulation ? 'not-allowed' : 'pointer',
            transition: 'all var(--transition-fast)',
          }}
        >
          <Lock size={14} />
          Simulate 2PC Distributed Write
        </button>

        <button
          onClick={triggerOversellMutexSimulation}
          disabled={activeSimulation !== null}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.45rem 0.9rem',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.84rem',
            fontWeight: '600',
            backgroundColor: activeSimulation === 'MUTEX' ? 'var(--status-success)' : 'rgba(16, 185, 129, 0.15)',
            color: activeSimulation === 'MUTEX' ? '#ffffff' : 'var(--status-success)',
            border: '1px solid rgba(16, 185, 129, 0.35)',
            cursor: activeSimulation ? 'not-allowed' : 'pointer',
            transition: 'all var(--transition-fast)',
          }}
        >
          <ShieldCheck size={14} />
          Simulate Anti-Oversell Mutex Lock
        </button>
      </div>

      {/* Mesh Visualizer Canvas */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.1fr 1fr',
          gap: '1.5rem',
          alignItems: 'stretch',
        }}
      >
        {/* Node Topology Graphic */}
        <div
          style={{
            backgroundColor: 'rgba(6, 9, 19, 0.85)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            position: 'relative',
          }}
        >
          {/* Coordinator Node at top */}
          <div
            style={{
              padding: '1rem',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              border: '2px solid rgba(99, 102, 241, 0.5)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              boxShadow: '0 0 20px rgba(99, 102, 241, 0.2)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#ffffff',
                }}
              >
                <Radio size={20} className="animate-spin" style={{ animationDuration: '6s' }} />
              </div>
              <div>
                <div style={{ fontWeight: '800', fontSize: '0.95rem', color: '#ffffff' }}>
                  Citus Coordinator (Primary)
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  coordinator:55432 • Distributed Catalog & Router
                </div>
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <Badge status="CONFIRMED" size="sm">MASTER ONLINE</Badge>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Zero SPOF HA Active
              </div>
            </div>
          </div>

          {/* Animated Conduit Connectors */}
          <div style={{ height: '50px', position: 'relative', margin: '0.5rem 0' }}>
            <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
              <line x1="50%" y1="0" x2="12.5%" y2="100%" stroke="rgba(255,255,255,0.15)" strokeWidth="2" strokeDasharray="4 4" />
              <line x1="50%" y1="0" x2="37.5%" y2="100%" stroke="rgba(255,255,255,0.15)" strokeWidth="2" strokeDasharray="4 4" />
              <line x1="50%" y1="0" x2="62.5%" y2="100%" stroke="rgba(255,255,255,0.15)" strokeWidth="2" strokeDasharray="4 4" />
              <line x1="50%" y1="0" x2="87.5%" y2="100%" stroke="rgba(255,255,255,0.15)" strokeWidth="2" strokeDasharray="4 4" />

              {/* Animated pulses */}
              {activeSimulation && (
                <>
                  <circle cx="50%" cy={`${packetPositions[0]}%`} r="5" fill="#6366f1" style={{ filter: 'drop-shadow(0 0 6px #6366f1)' }} />
                  <circle cx="50%" cy={`${packetPositions[1]}%`} r="5" fill="#06b6d4" style={{ filter: 'drop-shadow(0 0 6px #06b6d4)' }} />
                  <circle cx="50%" cy={`${packetPositions[2]}%`} r="5" fill="#10b981" style={{ filter: 'drop-shadow(0 0 6px #10b981)' }} />
                  <circle cx="50%" cy={`${packetPositions[3]}%`} r="5" fill="#a855f7" style={{ filter: 'drop-shadow(0 0 6px #a855f7)' }} />
                </>
              )}
            </svg>
          </div>

          {/* 4 Distributed Worker Nodes Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.65rem' }}>
            {workers.map((w, idx) => (
              <div
                key={w.id}
                style={{
                  padding: '0.85rem 0.65rem',
                  backgroundColor: 'var(--bg-secondary)',
                  border: `1px solid ${activeSimulation ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                  borderRadius: 'var(--radius-md)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                  transition: 'all 0.3s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: '700', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
                    Worker {w.id}
                  </span>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#10b981', boxShadow: '0 0 6px #10b981' }} />
                </div>

                <div style={{ fontSize: '0.7rem', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                  32 Shards
                </div>

                {/* Shard Load Bar */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '2px' }}>
                    <span>Load</span>
                    <span>{w.load}%</span>
                  </div>
                  <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${w.load}%`,
                        height: '100%',
                        backgroundColor: w.load > 70 ? 'var(--status-danger)' : 'var(--accent-primary)',
                        transition: 'width 0.5s ease',
                      }}
                    />
                  </div>
                </div>

                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', paddingTop: '0.35rem' }}>
                  Tx: <strong style={{ color: 'var(--text-primary)' }}>{w.activeTransactions}</strong>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Real-Time Telemetry & Saga Event Log */}
        <div
          style={{
            backgroundColor: 'rgba(6, 9, 19, 0.85)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Activity size={15} style={{ color: 'var(--accent-cyan)' }} />
              Distributed Shard Event Log
            </span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              Auto-Streaming
            </span>
          </div>

          <div
            style={{
              flex: 1,
              minHeight: '220px',
              maxHeight: '260px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
            }}
          >
            {simulationLogs.map((log) => (
              <div
                key={log.id}
                style={{
                  padding: '0.45rem 0.65rem',
                  borderRadius: 'var(--radius-xs)',
                  backgroundColor: log.type === 'success' ? 'rgba(16, 185, 129, 0.08)' : log.type === 'warning' ? 'rgba(245, 158, 11, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  borderLeft: `3px solid ${log.type === 'success' ? '#10b981' : log.type === 'warning' ? '#f59e0b' : '#38bdf8'}`,
                  color: log.type === 'success' ? '#a7f3d0' : log.type === 'warning' ? '#fde68a' : '#cbd5e1',
                  lineHeight: '1.4',
                }}
              >
                <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>[{log.time}]</span>
                {log.text}
              </div>
            ))}
          </div>

          {/* Educational Note */}
          <div
            style={{
              padding: '0.65rem 0.85rem',
              backgroundColor: 'rgba(99, 102, 241, 0.08)',
              border: '1px solid rgba(99, 102, 241, 0.2)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.76rem',
              color: 'var(--text-secondary)',
            }}
          >
            <strong style={{ color: '#ffffff' }}>Why Citus Sharding Matters: </strong>
            104M users and 60M flights are hash-partitioned on `user_id` and `flight_id`. Because cabin seat counters are colocated on the worker owning the flight, bookings execute entirely locally on a single shard node without costly distributed table locks.
          </div>
        </div>
      </div>
    </div>
  );
}
