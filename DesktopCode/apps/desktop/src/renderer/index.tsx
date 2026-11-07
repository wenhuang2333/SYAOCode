import { createRoot } from 'react-dom/client';
import { useWorkbench } from './use-workbench';
import { WorkbenchView } from './workbench';
import '@syaocode/ui/styles.css';
// 令牌层必须最先加载：workbench/dashboard 里的所有颜色都引用它。
import './theme-tokens.css';
import './workbench.css';
import './dashboard.css';

function App() {
  const workbench = useWorkbench();
  return <WorkbenchView w={workbench} />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
