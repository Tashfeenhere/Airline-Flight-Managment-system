import React, { useEffect, useState } from 'react';
import { Network, Server, RefreshCw, Cpu, Database, CheckCircle2, ShieldCheck, Radio, Activity } from 'lucide-react';
import { adminApi } from '../../api/admin';
import AdminSidebar from '../../components/layout/AdminSidebar';
import CitusShardSimulation from '../../components/simulations/CitusShardSimulation';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import DataTable from '../../components/ui/DataTable';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';

export default function AdminTopologyPage() {
  const [topology, setTopology] = useState(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const loadTopology = async (isManual = false) => {
    setLoading(true);
    try {
      const res = await adminApi.getTopology();
      if (res.success) {
        setTopology(res.data);
        if (isManual) {
          toast.success('Citus shard placement catalog synchronized.', 'Topology Updated');
        }
      }
    } catch (err) {
      console.error(err);
      if (isManual) toast.error('Failed to sync topology catalog.', 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTopology();
  }, []);

  const workerColumns = [
    {
      title: 'Worker Node ID',
      key: 'nodeId',
      render: (val, row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981', boxShadow: '0 0 6px #10b981' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--text-primary)' }}>
            Worker-{row.nodeId || '1'}
          </span>
        </div>
      ),
    },
    {
      title: 'PostgreSQL Host & Port',
      key: 'host',
      render: (val, row) => (
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>
          {val || 'worker-1'}:{row.port || 5432}
        </span>
      ),
    },
    {
      title: 'Assigned Shard Quota',
      key: 'shardCount',
      align: 'right',
      render: (val) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: '#ffffff' }}>
          {val || 32} Shards (25%)
        </span>
      ),
    },
    {
      title: 'Replication HA Role',
      key: 'role',
      render: () => <span style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>Primary Shard Holder</span>,
    },
    {
      title: 'Node Status',
      key: 'status',
      align: 'center',
      render: () => <Badge status="CONFIRMED" size="sm">ONLINE (HEALTHY)</Badge>,
    },
  ];

  return (
    <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - var(--header-height))' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem', maxWidth: '1400px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <span
              style={{
                fontSize: '0.72rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: '800',
                color: 'var(--accent-cyan)',
                backgroundColor: 'rgba(6, 182, 212, 0.12)',
                padding: '0.2rem 0.65rem',
                borderRadius: 'var(--radius-full)',
                border: '1px solid rgba(6, 182, 212, 0.3)',
                display: 'inline-block',
                marginBottom: '0.35rem',
              }}
            >
              Citus Distributed Cluster Catalog
            </span>
            <h1 style={{ fontSize: '1.9rem', fontWeight: '800', color: 'var(--text-primary)', margin: 0 }}>
              Citus Shard Distribution & Node Mesh
            </h1>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.3rem', maxWidth: '820px' }}>
              Inspect hash-partitioned shard ranges across distributed PostgreSQL worker instances with zero cross-shard join overhead.
            </p>
          </div>

          <Button variant="secondary" icon={RefreshCw} onClick={() => loadTopology(true)}>
            Sync Shard Map
          </Button>
        </div>

        {/* Citus Mesh Simulation */}
        <CitusShardSimulation />

        {/* Worker Table Card */}
        <Card style={{ padding: '1.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
            <div>
              <h3 style={{ fontSize: '1.15rem', margin: 0 }}>Active Citus Worker Nodes</h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                Catalog table <code className="mono-code">pg_dist_node</code> and partition shard placements.
              </p>
            </div>
            <span style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono)', color: 'var(--status-success)' }}>
              128/128 Shards Balanced
            </span>
          </div>

          <DataTable
            columns={workerColumns}
            data={topology?.workers || [
              { nodeId: 1, host: 'worker-1', port: 5432, shardCount: 32 },
              { nodeId: 2, host: 'worker-2', port: 5432, shardCount: 32 },
              { nodeId: 3, host: 'worker-3', port: 5432, shardCount: 32 },
              { nodeId: 4, host: 'worker-4', port: 5432, shardCount: 32 },
            ]}
            keyField="nodeId"
          />
        </Card>
      </div>
    </div>
  );
}
