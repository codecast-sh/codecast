" Synthetic vimrc: the shapes heavy real configs use. Not anyone's config.
set nocompatible
filetype plugin indent on
syntax on

call plug#begin('~/.vim/plugged')
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-surround'
Plug 'scrooloose/nerdtree', { 'on': 'NERDTreeToggle' }
Plug 'ctrlpvim/ctrlp.vim'
Plug 'tpope/vim-fugitive'
call plug#end()

let mapleader = "'"
let maplocalleader = "\<Space>"
let g:ctrlp_show_hidden = 1

set tabstop=4 shiftwidth=4 expandtab " four spaces
set number relativenumber
set nowrap
set scrolloff=8
set ignorecase smartcase hlsearch incsearch
set clipboard=unnamed
set colorcolumn=+1 textwidth=100
set iskeyword+=-
set backupdir=~/.vim/backup// noswapfile
set guifont=Menlo:h14
set foobarbaz=3
set timeoutlen=500

if has('gui_running')
  set guioptions-=T
  nnoremap <D-s> :w<CR>
else
  set t_Co=256
  set ttymouse=xterm2
endif

if has('nvim')
  set inccommand=nosplit
  tnoremap <Esc> <C-\><C-n>
endif

if exists('+colorcolumn') && v:version >= 703
  set cursorline
endif

if executable('rg')
  set grepprg=rg\ --vimgrep
endif

" Option-key glyphs typed on a Mac keyboard.
nnoremap ˙ <C-w>h
nnoremap ∆ <C-w>j
nnoremap ˚ <C-w>k
nnoremap ¬ <C-w>l
nnoremap <silent> π :CtrlPBuffer<CR>

nnoremap <leader>w :w<CR>
nnoremap <leader>n :NERDTreeToggle<CR>
nnoremap <leader>f :NERDTreeFind<CR>
nnoremap <C-p> :CtrlP<CR>
nnoremap <leader>g :Rg <C-R><C-W><CR>
nnoremap <leader>* yiw:Rg <C-R>"<CR>
nnoremap <leader>gd :Gdiffsplit<CR>
nnoremap <leader>gb :Git blame<CR>
nnoremap ]q :cnext<CR>
nnoremap [q :cprev<CR>
nnoremap <leader>a :ALEToggle<CR>
nnoremap <leader>s :call StripTrailing()<CR>
nnoremap <leader>v <C-w>v
nnoremap <localleader>x dd
nnoremap Y y$
inoremap jk <Esc>
vnoremap < <gv
xmap <leader>c <Plug>Commentary
nmap <leader>cc <Plug>CommentaryLine
nnoremap <expr> j v:count ? 'j' : 'gj'
nnoremap <leader>e :e $MYVIMRC<CR>
cnoremap <C-a> <Home>
cnoreabbrev W w
cnoreabbrev Wq wq
smap <Tab> <Plug>snipMateNextOrTrigger
noremap! <C-b> <Left>
iabbrev teh the
nnoremap <leader>l :nohlsearch<CR>| nnoremap <leader>q :q<CR>

command! -nargs=* Grep Rg <args>
command! Q q
command! -bang Kill call KillBuffer(<bang>0)

function! StripTrailing()
  let l:save = winsaveview()
  %s/\s\+$//e
  call winrestview(l:save)
endfunction

augroup filetypes
  autocmd!
  autocmd FileType python setlocal tabstop=4 shiftwidth=4
  autocmd FileType go setlocal noexpandtab tabstop=8 | setlocal colorcolumn=
  autocmd FileType markdown,text setlocal wrap linebreak spell
  autocmd BufWritePre * :%s/\s\+$//e
augroup END

autocmd FileType javascript,typescript setlocal sw=2 ts=2
autocmd BufRead,BufNewFile *.md set filetype=markdown

let g:fzf_layout = { 'window': {
      \ 'width': 0.9,
      \ 'height': 0.6 } }

nnoremap <leader>t
      \ :Files<CR>

lua << EOF
require('packer').startup(function(use)
  use 'wbthomason/packer.nvim'
  use 'nvim-telescope/telescope.nvim'
end)
EOF

colorscheme solarized
highlight Comment ctermfg=gray
