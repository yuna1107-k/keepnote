import { Outlet } from 'react-router-dom';

/** 管理者画面（メニューは通常のサイドバーの「管理者画面」の下に表示する） */
export default function AdminLayout() {
  return (
    <div className="admin-main">
      <Outlet />
    </div>
  );
}
