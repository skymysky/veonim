import { InventoryLayerKind } from '../core/inventory-layers'
import { Plugin } from '../components/plugin-container'
import Input from '../components/text-input'
import { createVim } from '../core/sessions'
import * as Icon from 'hyperapp-feather'
import { app } from '../ui/uikit'
import nvim from '../core/neovim'

const state = {
  value: '',
  visible: false,
}

type S = typeof state

const actions = {
  show: () => ({ visible: true }),
  hide: () => ({ value: '', visible: false }),
  change: (value: string) => ({ value }),
  select: () => (s: S) => {
    s.value && createVim(s.value)
    return { value: '', visible: false }
  },
}

type A = typeof actions

const view = ($: S, a: A) => Plugin($.visible, [

  ,Input({
    hide: a.hide,
    select: a.select,
    change: a.change,
    value: $.value,
    focus: true,
    icon: Icon.FolderPlus,
    desc: 'create new vim session',
  })

])

const ui = app<S, A>({ name: 'vim-create', state, actions, view })

nvim.onAction('vim-create', ui.show)

nvim.registerAction({
  layer: InventoryLayerKind.Instance,
  keybind: 'c',
  name: 'Create',
  description: 'Create new Neovim instance',
  onAction: ui.show,
})
