#!/bin/zsh
# Print the zsh completion candidates for a command line, one per line, as
#   <word>[ -- <description>]
# Usage: capture-completion.zsh '<command line>'
#
# The line is typed into a private interactive zsh on a pseudo terminal, Tab
# is pressed, and compadd is wrapped so every candidate the completion system
# produces is printed instead of inserted. Nothing on the line is executed.
#
# SHELL_COMMAND_FPATH (newline-separated) replaces $fpath so completion
# functions installed by oh-my-zsh, Homebrew and friends are found.
#
# Technique after zsh-capture-completion by Valodim (MIT license).

zmodload zsh/zpty || { print -u2 'error: missing module zsh/zpty'; exit 1 }

zpty z zsh -f -i

local line
setopt rcquotes

() {
  zpty -w z source $1
  repeat 4; do
    zpty -r z line
    [[ $line == ok* ]] && return
  done
  print -u2 'error initializing'
  exit 2
} =( <<< '
PROMPT=
if [[ -n $SHELL_COMMAND_FPATH ]]; then
  fpath=( ${(f)SHELL_COMMAND_FPATH} $fpath )
  typeset -U fpath
fi
autoload -U compinit
compinit -i -C -d "${SHELL_COMMAND_ZCOMPDUMP:-$HOME/.zcompdump-dsh-shell-command}"
bindkey ''^M'' undefined
bindkey ''^J'' undefined
bindkey ''^I'' complete-word
null-line () { echo -E - $''\0'' }
compprefuncs=( null-line )
comppostfuncs=( null-line exit )
zstyle '':completion:*'' list-grouped false
zstyle '':completion:*'' insert-tab false
zstyle '':completion:*'' list-separator ''''
zmodload zsh/zutil
compadd () {
  if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
    builtin compadd "$@"
    return $?
  fi
  typeset -a __hits __dscr __tmp
  if (( $@[(I)-d] )); then
    __tmp=${@[$[${@[(i)-d]}+1]]}
    if [[ $__tmp == \(* ]]; then
      eval "__dscr=$__tmp"
    else
      __dscr=( "${(@P)__tmp}" )
    fi
  fi
  builtin compadd -A __hits -D __dscr "$@"
  setopt localoptions norcexpandparam extendedglob
  typeset -A apre hpre hsuf asuf
  zparseopts -E P:=apre p:=hpre S:=asuf s:=hsuf
  integer dirsuf=0
  if [[ -z $hsuf && "${${@//-default-/}% -# *}" == *-[[:alnum:]]#f* ]]; then
    dirsuf=1
  fi
  [[ -n $__hits ]] || return
  local dsuf dscr
  for i in {1..$#__hits}; do
    (( dirsuf )) && [[ -d $__hits[$i] ]] && dsuf=/ || dsuf=
    (( $#__dscr >= $i )) && dscr=" -- ${${__dscr[$i]}##$__hits[$i] #}" || dscr=
    echo -E - $IPREFIX$apre$hpre$__hits[$i]$dsuf$hsuf$asuf$dscr
  done
}
echo ok')

zpty -w z "$*"$'\t'

integer tog=0
while zpty -r z; do :; done | while IFS= read -r line; do
  if [[ $line == *$'\0\r' ]]; then
    (( tog++ )) && return 0 || continue
  fi
  (( tog )) && echo -E - $line
done

return 2
