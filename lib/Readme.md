# Extending Command

to create a new command you will need to extend Command, you can either access command as a Static property of Shell:
```js
class Test extends Shell.Command {
    ...
}
```
 
or Require Command directly:
```js
const Command = require('shell.js/lib/Command');
 
class Test extends Command {
    ...
}
```

for some examples see the [implementation for piratemedia.tv](https://github.com/eliotstocker/piratemedia.tv/tree/master/fs/bin)

more info coming soon...