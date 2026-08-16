import React from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { MIX_ROW_COLORS, PIE_COLORS } from './dashboardConfig'
import { ChartEmpty, ChartTooltip } from './DashboardChartHelpers'
import useLanguage from '../../../hooks/useLanguage'
import styles from './AdminDashboard.module.scss'

export default function DashboardAnalytics({
  dashboard,
  attemptStatusBreakdown,
  scoreDistribution,
  roleDistribution,
  testStatusBreakdown,
  trendData,
}) {
  const { t, dir } = useLanguage()
  const isRtl = dir === 'rtl'
  const maxRoleValue = roleDistribution.length ? Math.max(...roleDistribution.map((entry) => entry.value), 1) : 1
  const maxTestValue = testStatusBreakdown.length ? Math.max(...testStatusBreakdown.map((entry) => entry.value), 1) : 1

  return (
    <div className={styles.analyticsGrid}>
      <section className={styles.panelCard}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.panelEyebrow}>{t('admin_dash_analytics_trend')}</div>
            <h3 className={styles.panelTitle}>{t('admin_dash_analytics_attempts_last_7_days')}</h3>
          </div>
        </div>
        <div className={styles.chartBody}>
          {trendData.some((point) => point.value > 0) ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={trendData} margin={{ top: 12, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="attemptTrendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0891b2" stopOpacity={0.32} />
                    <stop offset="95%" stopColor="#0891b2" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.18)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" reversed={isRtl} tick={{ fill: 'var(--color-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} orientation={isRtl ? 'right' : 'left'} tick={{ fill: 'var(--color-muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={26} />
                <Tooltip content={<ChartTooltip formatter={(value) => `${value} ${t('admin_dash_analytics_attempts')}`} />} />
                <Area
                  type="monotone"
                  dataKey="value"
                  name={t('admin_dash_analytics_attempts')}
                  stroke="#0891b2"
                  strokeWidth={3}
                  fill="url(#attemptTrendFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <ChartEmpty title={t('admin_dash_analytics_no_recent_attempts')} />
          )}
        </div>
      </section>

      <section className={styles.panelCard}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.panelEyebrow}>{t('admin_dash_analytics_workflow')}</div>
            <h3 className={styles.panelTitle}>{t('admin_dash_analytics_attempt_status_mix')}</h3>
          </div>
          <div className={styles.panelMeta}>{dashboard.total_attempts} {t('admin_dash_analytics_total')}</div>
        </div>
        <div className={styles.donutWrap}>
          {attemptStatusBreakdown.some((item) => item.value > 0) ? (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={attemptStatusBreakdown.filter((item) => item.value > 0)}
                    dataKey="value"
                    nameKey="label"
                    innerRadius={58}
                    outerRadius={86}
                    paddingAngle={3}
                    strokeWidth={0}
                  >
                    {attemptStatusBreakdown.filter((item) => item.value > 0).map((entry, index) => (
                      <Cell key={entry.key} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip formatter={(value) => `${value} ${t('admin_dash_analytics_attempts')}`} />} />
                </PieChart>
              </ResponsiveContainer>
              <div className={styles.legendList}>
                {attemptStatusBreakdown.filter((item) => item.value > 0).map((item, index) => (
                  <div key={item.key} className={styles.legendRow}>
                    <span className={styles.legendSwatch} style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }} />
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <ChartEmpty title={t('admin_dash_analytics_no_attempt_statuses')} />
          )}
        </div>
      </section>

      <section className={styles.panelCard}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.panelEyebrow}>{t('admin_dash_analytics_performance')}</div>
            <h3 className={styles.panelTitle}>{t('admin_dash_analytics_score_distribution')}</h3>
          </div>
        </div>
        <div className={styles.chartBody}>
          {scoreDistribution.some((item) => item.value > 0) ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={scoreDistribution} margin={{ top: 12, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.18)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" reversed={isRtl} tick={{ fill: 'var(--color-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} orientation={isRtl ? 'right' : 'left'} tick={{ fill: 'var(--color-muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={26} />
                <Tooltip content={<ChartTooltip formatter={(value) => `${value} ${t('admin_dash_analytics_attempts')}`} />} />
                <Bar dataKey="value" name={t('admin_dash_analytics_attempts')} radius={[8, 8, 0, 0]}>
                  {scoreDistribution.map((entry, index) => (
                    <Cell key={entry.key} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ChartEmpty title={t('admin_dash_analytics_no_scores_available')} />
          )}
        </div>
      </section>

      <section className={styles.panelCard}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.panelEyebrow}>{t('admin_dash_analytics_composition')}</div>
            <h3 className={styles.panelTitle}>{t('admin_dash_analytics_platform_mix')}</h3>
          </div>
        </div>
        <div className={styles.mixSection}>
          <div className={styles.mixBlock}>
            <div className={styles.mixTitle}>{t('admin_dash_analytics_user_roles')}</div>
            {roleDistribution.length > 0 ? roleDistribution.map((item, index) => (
              <div key={item.key} className={styles.mixRow}>
                <div className={styles.mixLabelRow}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
                <div className={styles.mixTrack}>
                  <span
                    className={styles.mixFill}
                    style={{
                      width: `${(item.value / maxRoleValue) * 100}%`,
                      backgroundColor: MIX_ROW_COLORS[index % MIX_ROW_COLORS.length],
                    }}
                  />
                </div>
              </div>
            )) : (
              <div className={styles.inlineEmpty}>{t('admin_dash_analytics_no_role_data')}</div>
            )}
          </div>

          <div className={styles.mixBlock}>
            <div className={styles.mixTitle}>{t('admin_dash_analytics_test_status')}</div>
            {testStatusBreakdown.length > 0 ? testStatusBreakdown.map((item, index) => (
              <div key={item.key} className={styles.mixRow}>
                <div className={styles.mixLabelRow}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
                <div className={styles.mixTrack}>
                  <span
                    className={styles.mixFill}
                    style={{
                      width: `${(item.value / maxTestValue) * 100}%`,
                      backgroundColor: MIX_ROW_COLORS[(index + 1) % MIX_ROW_COLORS.length],
                    }}
                  />
                </div>
              </div>
            )) : (
              <div className={styles.inlineEmpty}>{t('admin_dash_analytics_no_test_mix')}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
