/**
 * The explorer's tree: file paths folded into folders, VS Code style — folders first, by name;
 * files in the order they were given (step files keep their step order). `leaf` is whatever the
 * row needs to render the file.
 */

export interface FileLeaf<T> {
  path: string;
  leaf: T;
}

export type TreeNode<T> =
  | {kind: 'folder'; name: string; path: string; children: TreeNode<T>[]}
  | {kind: 'file'; name: string; path: string; leaf: T};

export function buildTree<T>(files: readonly FileLeaf<T>[]): TreeNode<T>[] {
  const root: TreeNode<T>[] = [];
  const folders = new Map<string, TreeNode<T>[]>();
  const childrenOf = (dir: string): TreeNode<T>[] => {
    if (dir === '') return root;
    const known = folders.get(dir);
    if (known !== undefined) return known;
    const slash = dir.lastIndexOf('/');
    const parent = childrenOf(slash < 0 ? '' : dir.slice(0, slash));
    const children: TreeNode<T>[] = [];
    parent.push({kind: 'folder', name: slash < 0 ? dir : dir.slice(slash + 1), path: dir, children});
    folders.set(dir, children);
    return children;
  };
  for (const {path, leaf} of files) {
    const slash = path.lastIndexOf('/');
    childrenOf(slash < 0 ? '' : path.slice(0, slash)).push({
      kind: 'file',
      name: slash < 0 ? path : path.slice(slash + 1),
      path,
      leaf,
    });
  }
  const order = (nodes: TreeNode<T>[]): TreeNode<T>[] => {
    const dirs = nodes.filter(n => n.kind === 'folder').sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) if (d.kind === 'folder') d.children = order(d.children);
    return [...dirs, ...nodes.filter(n => n.kind === 'file')];
  };
  return order(root);
}
