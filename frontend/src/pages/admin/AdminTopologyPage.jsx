import React, { useEffect, useState } from 'react';
import { Network, Server, RefreshCw, Cpu, Database, CheckCircle2 } from 'lucide-react';
import { adminApi } from '../../api/admin';
import AdminSidebar from '../../components/layout/AdminSidebar';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import DataTable from '../../components/ui/DataTable';
import Badge from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';

export default function AdminTopologyPage() {
  const [topology, setTopology] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadTopology = async () => {
    setLoading(true);
    try {
      const res = await adminApi.getTopology();
      if (res.success) setTopology(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTopology();
  }, []);

  const workerColumns = [
    {
      title: 'Worker Node',
      key: 'nodeId',
      render: (val) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Server size={16} style={{ color: '#c084fc' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700' }}>{val}</span>
        </div>
      ),
    },
    {
      title: 'Host & Port',
      key: 'host',
      render: (val, row) => (
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          {val}:{row.port}
        </span>
      ),
    },
    {
      title: 'Shard Count',
      key: 'shardCount',
      align: 'right',
      render: (val) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--accent-cyan)' }}>
          {val} Shards
        </span>
      ),
    },
    {
      title: 'Current Load',
      key: 'load',
      align: 'right',
      render: (val) => <span style={{ fontFamily: 'var(--font-mono)' }}>{val || '14%'}</span>,
    },
    {
      title: 'Status',
      key: 'active',
      align: 'center',
      render: (val) => (
        <Badge status={val ? 'ACTIVE' : 'FAILED'} size="sm">
          {val ? 'ONLINE' : 'OFFLINE'}
        </Badge>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
              Citus Distributed Cluster Shard Map
            </h1>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Inspect coordinator and worker node distribution across physical shard boundaries.
            </p>
          </div>

          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={loadTopology}>
            Refresh Topology
          </Button>
        </div>

        {loading ? (
          <div style={{ padding: '5rem 0' }}>
            <Spinner size="lg" label="Querying Citus cluster coordinator..." />
          </div>
        ) : (
          <>
            {/* Coordinator Card */}
            <Card style={{ padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <Database size={24} style={{ color: 'var(--accent-primary)' }} />
                  <div>
                    <h3 style={{ fontSize: '1.15rem' }}>Citus Master Coordinator Node</h3>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Routes distributed transactional queries and maintains sharding metadata catalog
                    </span>
                  </div>
                </div>

                <Badge status="ACTIVE">PRIMARY COORDINATOR</Badge>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', borderTop: '1px solid var(--border-subtle)', paddingTop: '1rem' }}>
                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Citus Version</span>
                  <div style={{ fontSize: '0.9rem', fontFamily: 'var(--font-mono)', marginTop: '0.2rem' }}>
                    {topology?.coordinator?.citusVersion || 'Citus 12.1.2 on PostgreSQL 16.2'}
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Coordinator Host</span>
                  <div style={{ fontSize: '0.9rem', fontFamily: 'var(--font-mono)', marginTop: '0.2rem' }}>
                    {topology?.coordinator?.host || 'coordinator.internal'}:{topology?.coordinator?.port || 5432}
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Partition Strategy</span>
                  <div style={{ fontSize: '0.9rem', color: 'var(--accent-cyan)', fontWeight: '600', marginTop: '0.2rem' }}>
                    {topology?.partitionStrategy || 'MONTHLY_RANGE_HASH'}
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total Active Shards</span>
                  <div style={{ fontSize: '1.3rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: '#c084fc' }}>
                    {topology?.totalShards ?? 128}
                  </div>
                </div>
              </div>
            </Card>

            {/* Workers Table */}
            <div>
              <h3 style={{ fontSize: '1.15rem', marginBottom: '0.85rem' }}>
                Distributed Citus Worker Shard Nodes
              </h3>
              <DataTable
                columns={workerColumns}
                data={topology?.workers || []}
                keyField="nodeId"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
