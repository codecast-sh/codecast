" Synthetic: one-line structure and comments on structure lines.
if has('mouse') | set mouse=a | endif
nnoremap <Space>w :w<CR>
set number
augroup vimrc | autocmd! | augroup END
nnoremap <leader>q :q<CR>
if has('nvim') | set inccommand=split | endif
set hlsearch
if has('gui_running')
  if has('nvim') | set icm=nosplit | endif
  set lines=40
endif
if has('nvim')
  if has('mac') | set linebreak | endif
  set showtabline=2
endif
nnoremap <Space>z zz
if !has('nvim') " plain vim
  set cursorline
endif " vim only
if has('nvim')
  set norelativenumber
else " vim
  set relativenumber
endif " gui
for f in ['a'] | echo f | endfor
set wrap
function! F() | return 1 | endfunction
set scrolloff=3
augroup ft | autocmd FileType go setlocal ts=8 | augroup END
set incsearch
set textwidth=100
nnoremap <leader>s :w<CR>
augroup unclosed
  autocmd FileType rust setlocal sw=4
set shiftwidth=2
augroup other
  autocmd!
  autocmd FileType python setlocal ts=4
  autocmd BufWritePre * echo 1
augroup END
set colorcolumn=80
