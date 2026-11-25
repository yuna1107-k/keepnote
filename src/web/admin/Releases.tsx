import { buildInfo } from '../buildInfo';
import { RELEASES } from '../releases';

const TYPE: Record<string, { label: string; tone: string }> = {
  new: { label: '新機能', tone: 'info' },
  improve: { label: '改善', tone: 'success' },
  fix: { label: '修正', tone: 'warn' },
  security: { label: 'セキュリティ', tone: 'danger' },
};

export default function Releases() {
  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h1>リリース履歴</h1>
          <p className="muted small">
            現在のバージョン：v{buildInfo.version}（{buildInfo.commit}）
          </p>
        </div>
      </div>
      <div className="releases">
        {RELEASES.map((r) => (
          <section key={r.version} className="card release">
            <div className="release-head">
              <span className={`release-version ${r.version === buildInfo.version ? 'current' : ''}`}>v{r.version}</span>
              <h2>{r.title}</h2>
              <span className="muted small">{r.date}</span>
              {r.version === buildInfo.version && <span className="badge badge-success">現在のバージョン</span>}
            </div>
            <ul className="release-list">
              {r.changes.map((c, i) => (
                <li key={i}>
                  <span className={`badge badge-${TYPE[c.type]!.tone}`}>{TYPE[c.type]!.label}</span>
                  {c.app && <span className="badge badge-muted release-app">アプリ</span>}
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
