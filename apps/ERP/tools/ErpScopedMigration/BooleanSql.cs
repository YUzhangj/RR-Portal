using System.Text;
using System.Text.Json;

// Parse only the scalar/boolean SQL subset used by the reviewed schema contract.
// Parentheses disappear only after parsing, so function boundaries, arithmetic
// grouping and AND/OR precedence remain part of the canonical tree.
internal static class BooleanSql
{
    internal static string Canonical(string expression) => new Parser(expression).Parse().Render();

    private sealed record Node(string Kind, string Value, bool Predicate, Node[] Children)
    {
        internal string Render() => JsonSerializer.Serialize(new[] { Kind, Value }) +
            "[" + string.Join(",", Children.Select(child => child.Render())) + "]";
    }

    private sealed class Parser
    {
        private readonly string text;
        private int position, depth, tokens;
        private Token token;

        internal Parser(string expression)
        {
            if (string.IsNullOrWhiteSpace(expression) || expression.Length > 16384) Reject();
            text = expression;
            Next();
        }

        internal Node Parse()
        {
            var result = Expression(0);
            if (token.Kind != "end") Reject();
            return result;
        }

        private Node Expression(int minimum)
        {
            if (++depth > 128) Reject();
            Node left;
            if (Take("("))
            {
                left = Expression(0);
                Expect(")");
            }
            else if (token.Kind == "+" || token.Kind == "-")
            {
                var operation = token.Kind; Next();
                var operand = Expression(60);
                if (operand.Predicate) Reject();
                left = new("unary", operation, false, [operand]);
            }
            else if (TakeWord("NOT"))
            {
                var operand = Expression(30);
                if (!operand.Predicate) Reject();
                left = new("not", "", true, [operand]);
            }
            else if (token.Kind is "number" or "string" or "unicode-string")
            {
                left = new(token.Kind, token.Value, false, []); Next();
            }
            else if (token.Kind == "name")
            {
                var name = token.Value; Next();
                if (Take("("))
                {
                    var arguments = new List<Node>();
                    if (!Take(")"))
                    {
                        do { arguments.Add(Expression(0)); } while (Take(","));
                        Expect(")");
                    }
                    var arity = name switch { "LEN" or "DATALENGTH" => 1, "SYSDATETIME" => 0, _ => -1 };
                    if (arguments.Count != arity || arguments.Any(argument => argument.Predicate)) Reject();
                    left = new("call", name, false, arguments.ToArray());
                }
                else left = new("identifier", name, false, []);
            }
            else { Reject(); throw new InvalidOperationException(); }

            while (true)
            {
                if (IsWord("COLLATE") && minimum <= 70)
                {
                    Next();
                    if (left.Predicate || token.Kind != "name") Reject();
                    left = new("collate", token.Value, false, [left]); Next(); continue;
                }
                if (IsWord("IS") && minimum <= 30)
                {
                    Next(); var negate = TakeWord("NOT");
                    if (left.Predicate || !TakeWord("NULL")) Reject();
                    left = new(negate ? "is-not-null" : "is-null", "", true, [left]); continue;
                }
                var operation = token.Kind == "name" ? token.Value : token.Kind;
                var precedence = operation switch
                {
                    "OR" => 10, "AND" => 20,
                    "=" or "<>" or "!=" or ">" or ">=" or "<" or "<=" => 30,
                    "+" or "-" => 40, "*" or "/" or "%" => 50, _ => -1
                };
                if (precedence < minimum || precedence < 0) break;
                Next(); var right = Expression(precedence + 1);
                var boolean = operation is "AND" or "OR";
                if (boolean ? !left.Predicate || !right.Predicate : left.Predicate || right.Predicate) Reject();
                if (boolean)
                {
                    var children = new[] { left, right }.SelectMany(child => child.Kind == operation
                        ? child.Children : [child]).OrderBy(child => child.Render(), StringComparer.Ordinal).ToArray();
                    left = new(operation, "", true, children);
                }
                else left = new("binary", operation, precedence == 30, [left, right]);
            }
            depth--; return left;
        }

        private bool IsWord(string value) => token.Kind == "name" && token.Value == value;
        private bool TakeWord(string value) { if (!IsWord(value)) return false; Next(); return true; }
        private bool Take(string kind) { if (token.Kind != kind) return false; Next(); return true; }
        private void Expect(string kind) { if (!Take(kind)) Reject(); }

        private void Next()
        {
            if (++tokens > 4096) Reject();
            while (position < text.Length && char.IsWhiteSpace(text[position])) position++;
            if (position == text.Length) { token = new("end", ""); return; }
            var start = position; var character = text[position++];
            if (character == '\'' || (character is 'n' or 'N' && position < text.Length && text[position] == '\''))
            {
                var unicode = character != '\'';
                if (unicode) position++;
                var value = new StringBuilder();
                while (position < text.Length)
                {
                    character = text[position++];
                    if (character != '\'') { value.Append(character); continue; }
                    if (position < text.Length && text[position] == '\'') { position++; value.Append('\''); continue; }
                    token = new(unicode ? "unicode-string" : "string", value.ToString()); return;
                }
                Reject();
            }
            if (character == '[')
            {
                var value = new StringBuilder();
                while (position < text.Length)
                {
                    character = text[position++];
                    if (character != ']') { value.Append(character); continue; }
                    if (position < text.Length && text[position] == ']') { position++; value.Append(']'); continue; }
                    if (value.Length == 0) Reject();
                    token = new("name", value.ToString().ToUpperInvariant()); return;
                }
                Reject();
            }
            if (char.IsLetter(character) || character == '_')
            {
                while (position < text.Length && (char.IsLetterOrDigit(text[position]) || text[position] == '_')) position++;
                token = new("name", text[start..position].ToUpperInvariant()); return;
            }
            if (char.IsAsciiDigit(character))
            {
                while (position < text.Length && char.IsAsciiDigit(text[position])) position++;
                if (position < text.Length && text[position] == '.')
                {
                    position++;
                    if (position == text.Length || !char.IsAsciiDigit(text[position])) Reject();
                    while (position < text.Length && char.IsAsciiDigit(text[position])) position++;
                }
                token = new("number", text[start..position]); return;
            }
            if (character is '<' or '>' or '!' && position < text.Length && text[position] == '=') position++;
            else if (character == '<' && position < text.Length && text[position] == '>') position++;
            var symbol = text[start..position];
            if (symbol is not ("(" or ")" or "," or "+" or "-" or "*" or "/" or "%" or "=" or "<>" or "!=" or ">" or ">=" or "<" or "<=")) Reject();
            if ((symbol == "-" && position < text.Length && text[position] == '-') ||
                (symbol == "/" && position < text.Length && text[position] == '*')) Reject();
            token = new(symbol, symbol);
        }

        private static void Reject() => throw new MigrationRejected("unsupported_check_predicate");
        private readonly record struct Token(string Kind, string Value);
    }
}
