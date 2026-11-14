import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, Plus, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useCollections } from '../hooks/data';
import { toast } from './Toast';

export function CollectionPicker({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { data: collections = [] } = useCollections();
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const toggle = async (collectionId: string, inIt: boolean) => {
    const { error } = inIt
      ? await supabase.from('collection_items').delete().eq('collection_id', collectionId).eq('item_id', itemId)
      : await supabase.from('collection_items').insert({ collection_id: collectionId, item_id: itemId });
    if (error) return toast(error.message, 'error');
    // Keep collection items visible in the library view.
    if (!inIt) await supabase.from('library_items').upsert({ item_id: itemId }, { onConflict: 'user_id,item_id', ignoreDuplicates: true });
    qc.invalidateQueries({ queryKey: ['collections'] });
    qc.invalidateQueries({ queryKey: ['library'] });
  };

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    const { data, error } = await supabase.from('collections').insert({ name: n.slice(0, 80) }).select('id').single();
    if (error) return toast(error.message, 'error');
    setName('');
    await toggle(data.id, false);
    toast(`Added to “${n}”`);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/50 backdrop-blur-sm sm:place-items-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Add to collection">
      <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="safe-bottom w-full max-w-md rounded-t-3xl border border-line bg-ink-2 p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-xl">Add to collection</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-mist hover:text-bone"><X className="h-5 w-5" /></button>
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {collections.length === 0 && <p className="py-2 text-sm text-mist">No collections yet. Create your first below.</p>}
          {collections.map((c) => {
            const inIt = c.collection_items.some((x) => x.item_id === itemId);
            return (
              <button key={c.id} type="button" onClick={() => toggle(c.id, inIt)} className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left hover:bg-ink-3">
                <span>{c.name} <span className="text-xs text-dim">· {c.collection_items.length}</span></span>
                {inIt && <Check className="h-4 w-4 text-tide" />}
              </button>
            );
          })}
        </div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="New collection name" className="min-w-0 flex-1 rounded-xl border border-line bg-ink-3 px-3 py-2.5 text-sm placeholder:text-dim focus:border-ember/50 focus:outline-none" />
          <button type="submit" className="inline-flex items-center gap-1 rounded-xl bg-ember px-3.5 text-sm font-semibold text-ink"><Plus className="h-4 w-4" /> Create</button>
        </form>
      </motion.div>
    </div>
  );
}
