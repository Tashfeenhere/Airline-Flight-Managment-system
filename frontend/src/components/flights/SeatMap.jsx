import React, { useState } from 'react';
import { ShieldCheck, Info } from 'lucide-react';

export default function SeatMap({
  seatMapData,
  selectedSeat,
  onSelectSeat,
  cabin = 'ECONOMY',
}) {
  const [hoveredSeat, setHoveredSeat] = useState(null);

  if (!seatMapData || !seatMapData.columns || seatMapData.columns.length === 0) {
    return (
      <div
        style={{
          padding: '3rem',
          textAlign: 'center',
          backgroundColor: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-color)',
        }}
      >
        <p style={{ color: 'var(--text-muted)' }}>
          Seat map layout is currently unavailable for this aircraft configuration.
        </p>
      </div>
    );
  }

  const { columns, rows, seats } = seatMapData;
  const seatMapLookup = new Map();
  seats.forEach((seat) => {
    seatMapLookup.set(seat.seatNumber, seat);
  });

  const seatWidth = 34;
  const seatHeight = 34;
  const seatGap = 8;
  const aisleGap = 26;
  const rowLabelWidth = 38;

  // Calculate SVG dimensions
  let totalWidth = rowLabelWidth;
  columns.forEach((col) => {
    if (col === '_') totalWidth += aisleGap;
    else totalWidth += seatWidth + seatGap;
  });

  const totalHeight = 90 + rows.length * (seatHeight + seatGap);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-xl)',
        padding: '2rem 1.5rem',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {/* Legend */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.5rem',
          paddingBottom: '1.5rem',
          borderBottom: '1px solid var(--border-subtle)',
          width: '100%',
          fontSize: '0.82rem',
          color: 'var(--text-secondary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '4px',
              backgroundColor: 'rgba(16, 185, 129, 0.2)',
              border: '2px solid var(--status-success)',
            }}
          />
          <span>Available</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '4px',
              backgroundColor: 'var(--accent-primary)',
              boxShadow: '0 0 8px rgba(37, 99, 235, 0.6)',
            }}
          />
          <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>Selected</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '4px',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
            }}
          />
          <span>Occupied</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '4px',
              backgroundColor: 'rgba(245, 158, 11, 0.15)',
              border: '2px solid var(--status-warning)',
            }}
          />
          <span>Exit Row</span>
        </div>
      </div>

      {/* Selected Seat Notification Bar */}
      <div
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.85rem 1.25rem',
          marginTop: '1rem',
          backgroundColor: selectedSeat ? 'rgba(37, 99, 235, 0.12)' : 'rgba(255, 255, 255, 0.02)',
          border: `1px solid ${selectedSeat ? 'rgba(37, 99, 235, 0.3)' : 'var(--border-subtle)'}`,
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <Info size={16} style={{ color: selectedSeat ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
          <span style={{ fontSize: '0.88rem', color: selectedSeat ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            {selectedSeat ? (
              <>
                Selected Seat:{' '}
                <strong style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                  {selectedSeat}
                </strong>{' '}
                ({cabin.replace('_', ' ')})
              </>
            ) : (
              'Click an available seat below to make your selection'
            )}
          </span>
        </div>

        {selectedSeat && (
          <span
            style={{
              fontSize: '0.78rem',
              color: 'var(--status-success)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              fontWeight: '600',
            }}
          >
            <ShieldCheck size={14} /> Ready for Reservation
          </span>
        )}
      </div>

      {/* Aircraft Fuselage Graphic */}
      <div
        style={{
          width: '100%',
          maxWidth: `${Math.max(totalWidth + 60, 420)}px`,
          position: 'relative',
          paddingTop: '2rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {/* Cockpit / Nose cone */}
        <div
          style={{
            width: '140px',
            height: '45px',
            borderTopLeftRadius: '70px',
            borderTopRightRadius: '70px',
            border: '2px solid var(--border-color)',
            borderBottom: 'none',
            backgroundColor: 'var(--bg-surface-elevated)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.72rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: '600',
          }}
        >
          Front
        </div>

        {/* SVG Seat Grid */}
        <div
          style={{
            width: '100%',
            overflowX: 'auto',
            display: 'flex',
            justifyContent: 'center',
            backgroundColor: 'var(--bg-surface)',
            border: '2px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.5rem',
            position: 'relative',
          }}
        >
          <svg
            width={totalWidth}
            height={totalHeight}
            viewBox={`0 0 ${totalWidth} ${totalHeight}`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {/* Column Header Letters */}
            {(() => {
              let currentX = rowLabelWidth;
              return columns.map((col, idx) => {
                if (col === '_') {
                  currentX += aisleGap;
                  return null;
                }
                const xPos = currentX;
                currentX += seatWidth + seatGap;
                return (
                  <text
                    key={`col-${idx}`}
                    x={xPos + seatWidth / 2}
                    y={22}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize="12"
                    fontWeight="600"
                    fontFamily="var(--font-mono)"
                  >
                    {col}
                  </text>
                );
              });
            })()}

            {/* Rows and Seats */}
            {rows.map((rowNum, rIdx) => {
              const yPos = 45 + rIdx * (seatHeight + seatGap);
              let currentX = rowLabelWidth;

              return (
                <g key={`row-${rowNum}`}>
                  {/* Row Number Label */}
                  <text
                    x={rowLabelWidth / 2}
                    y={yPos + seatHeight / 2 + 4}
                    textAnchor="middle"
                    fill="var(--text-muted)"
                    fontSize="11"
                    fontFamily="var(--font-mono)"
                  >
                    {rowNum}
                  </text>

                  {/* Seats in this row */}
                  {columns.map((col, cIdx) => {
                    if (col === '_') {
                      currentX += aisleGap;
                      return null;
                    }

                    const seatNumber = `${rowNum}${col}`;
                    const seat = seatMapLookup.get(seatNumber) || {
                      seatNumber,
                      status: 'AVAILABLE',
                      isExitRow: false,
                      bookable: true,
                    };

                    const isAvailable = seat.status === 'AVAILABLE' && seat.bookable;
                    const isSelected = selectedSeat === seatNumber;
                    const isHovered = hoveredSeat === seatNumber;
                    const isExitRow = !!seat.isExitRow;

                    const xPos = currentX;
                    currentX += seatWidth + seatGap;

                    let fillColor = '#1e293b';
                    let strokeColor = '#334155';
                    let cursor = 'not-allowed';

                    if (isSelected) {
                      fillColor = 'var(--accent-primary)';
                      strokeColor = '#60a5fa';
                      cursor = 'pointer';
                    } else if (isAvailable) {
                      fillColor = isHovered ? 'rgba(16, 185, 129, 0.35)' : 'rgba(16, 185, 129, 0.15)';
                      strokeColor = isExitRow ? 'var(--status-warning)' : 'var(--status-success)';
                      cursor = 'pointer';
                    } else if (isExitRow) {
                      strokeColor = 'var(--status-warning)';
                    }

                    return (
                      <g
                        key={seatNumber}
                        onClick={() => isAvailable && onSelectSeat && onSelectSeat(seatNumber)}
                        onMouseEnter={() => setHoveredSeat(seatNumber)}
                        onMouseLeave={() => setHoveredSeat(null)}
                        style={{ cursor }}
                      >
                        {/* Seat Base Rect */}
                        <rect
                          x={xPos}
                          y={yPos}
                          width={seatWidth}
                          height={seatHeight}
                          rx={5}
                          ry={5}
                          fill={fillColor}
                          stroke={strokeColor}
                          strokeWidth={isSelected ? 2.5 : isExitRow ? 2 : 1.5}
                          style={{
                            transition: 'all 0.15s ease',
                            filter: isSelected ? 'drop-shadow(0 0 6px rgba(37,99,235,0.7))' : 'none',
                          }}
                        />

                        {/* Headrest accent line */}
                        <line
                          x1={xPos + 5}
                          y1={yPos + 6}
                          x2={xPos + seatWidth - 5}
                          y2={yPos + 6}
                          stroke={isSelected ? '#ffffff' : strokeColor}
                          strokeWidth={1.5}
                          strokeLinecap="round"
                          opacity={0.7}
                        />

                        {/* Seat Number Text inside Seat */}
                        <text
                          x={xPos + seatWidth / 2}
                          y={yPos + seatHeight / 2 + 5}
                          textAnchor="middle"
                          fill={
                            isSelected
                              ? '#ffffff'
                              : isAvailable
                              ? 'var(--text-primary)'
                              : 'var(--text-muted)'
                          }
                          fontSize="10"
                          fontWeight={isSelected ? '700' : '500'}
                          fontFamily="var(--font-mono)"
                          pointerEvents="none"
                        >
                          {col}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Tail / Rear cone */}
        <div
          style={{
            width: '180px',
            height: '25px',
            borderBottomLeftRadius: '90px',
            borderBottomRightRadius: '90px',
            border: '2px solid var(--border-color)',
            borderTop: 'none',
            backgroundColor: 'var(--bg-surface-elevated)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.72rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: '600',
          }}
        >
          Aft / Rear
        </div>
      </div>
    </div>
  );
}
