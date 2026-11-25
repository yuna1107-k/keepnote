import { useParams } from 'react-router-dom';
import { WorkspaceSettings } from '../workspace/Workspaces';

/** 管理者画面：ワークスペースの設定（名前・アイコン・URL 名・プライベート・メンバー） */
export default function AdminWorkspaceDetail() {
  const { id } = useParams();
  return <WorkspaceSettings key={id} workspaceId={id} adminMode />;
}
